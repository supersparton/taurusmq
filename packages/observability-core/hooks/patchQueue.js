// packages/observability-core/hooks/patchQueue.js
// Minimal non-invasive patch to Queue to emit observability events.
// Called once at startup: patchQueue(queueInstance, bus)
// No modifications to queue.js source file required.

'use strict';

const { EventType } = require('../types');

/**
 * Wraps Queue.add() and Queue.retry() to emit job lifecycle events.
 * Uses prototype patching so existing Queue instances are also patched.
 *
 * @param {Function} QueueClass   - The Queue constructor from src/core/queue.js
 * @param {Object}   bus          - ObservabilityBus singleton
 */
function patchQueue(QueueClass, bus) {
  const origAdd    = QueueClass.prototype.add;
  const origRetry  = QueueClass.prototype.retry;
  const origPause  = QueueClass.prototype.pause;
  const origResume = QueueClass.prototype.resume;

  // ── queue.add → job.created + job.waiting / job.delayed ──────────────
  QueueClass.prototype.add = async function(name, data, options = {}) {
    const jobId = await origAdd.call(this, name, data, options);

    const isDelayed = !!(options.delay || options.repeat);
    const hasParent = !!(options.parent && options.parent.length > 0);

    if (isDelayed) {
      const redis = require('../../../src/utils/redis');
      try {
        const rawJob = await redis.hget(this.rediskeyjobs, jobId);
        if (rawJob) {
          const parsed = JSON.parse(rawJob);
          parsed.status = 'delayed';
          await redis.hset(this.rediskeyjobs, jobId, JSON.stringify(parsed));
        }
      } catch (_) {}
    }

    bus.emit(EventType.JOB_CREATED, {
      queueName: this.queuename,
      jobId,
      jobName:    name,
      data,
      attempts:   0,
      maxRetries: options.maxretries ?? 3,
      batchId:    options.batchid   ?? null,
      parentIds:  options.parent    ?? [],
      repeatExpr: options.repeat    ?? null,
    });

    if (isDelayed) {
      bus.emit(EventType.JOB_DELAYED, { queueName: this.queuename, jobId, jobName: name });
    } else if (!hasParent) {
      bus.emit(EventType.JOB_WAITING, { queueName: this.queuename, jobId, jobName: name });
    }

    return jobId;
  };

  // ── queue.retry → job.retry ──────────────────────────────────────────
  QueueClass.prototype.retry = async function(jobid) {
    await origRetry.call(this, jobid);
    bus.emit(EventType.JOB_RETRY, {
      queueName: this.queuename,
      jobId:     jobid,
      jobName:   '',   // name recovered from Redis by metrics collector if needed
      attempt:   0,    // reset
    });
  };

  // ── queue.pause → queue.paused ───────────────────────────────────────
  if (origPause) {
    QueueClass.prototype.pause = async function(...args) {
      await origPause.call(this, ...args);
      bus.emit(EventType.QUEUE_PAUSED, { queueName: this.queuename });
    };
  }

  // ── queue.resume → queue.resumed ─────────────────────────────────────
  if (origResume) {
    QueueClass.prototype.resume = async function(...args) {
      await origResume.call(this, ...args);
      bus.emit(EventType.QUEUE_RESUMED, { queueName: this.queuename });
    };
  }
}

module.exports = { patchQueue };
