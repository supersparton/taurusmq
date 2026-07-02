// packages/observability-core/hooks/patchWorker.js
// Wraps Worker prototype methods to emit job.active, job.completed, job.failed,
// worker.heartbeat, worker.memory, worker.cpu events.

'use strict';

const os            = require('os');
const { EventType } = require('../types');

/**
 * @param {Function} WorkerClass  - Worker constructor from src/core/worker.js
 * @param {Object}   bus          - ObservabilityBus singleton
 */
function patchWorker(WorkerClass, bus) {
  const origStart = WorkerClass.prototype.start;
  const origWork  = WorkerClass.prototype.work;

  // ── Worker.start → worker.started + begin heartbeat/resource loops ───
  WorkerClass.prototype.start = async function(...args) {
    this._workerId   = `wkr_${this.queuename}_${process.pid}`;
    this._workerHost = os.hostname();
    this._activeJobTimestamps = new Map(); // jobId → startMs

    bus.emit(EventType.WORKER_STARTED, {
      queueName:  this.queuename,
      workerId:   this._workerId,
      workerHost: this._workerHost,
      concurrency: this.concurrency,
      pid:         process.pid,
    });

    // Start heartbeat loop (every 10s)
    this._heartbeatInterval = setInterval(() => {
      bus.emit(EventType.WORKER_HEARTBEAT, {
        queueName:  this.queuename,
        workerId:   this._workerId,
        activeJobs: [...this._activeJobTimestamps.keys()],
      });
    }, 10_000);

    // Start resource sampling loop (every 15s)
    let _prevCpu = process.cpuUsage();
    let _prevTs  = Date.now();

    this._resourceInterval = setInterval(() => {
      const mem     = process.memoryUsage();
      const nowCpu  = process.cpuUsage();
      const nowTs   = Date.now();
      const elapsedUs = (nowTs - _prevTs) * 1000; // microseconds

      const cpuUserDelta   = nowCpu.user   - _prevCpu.user;
      const cpuSystemDelta = nowCpu.system - _prevCpu.system;
      const cpuPercent     = ((cpuUserDelta + cpuSystemDelta) / elapsedUs) * 100;

      _prevCpu = nowCpu;
      _prevTs  = nowTs;

      bus.emit(EventType.WORKER_MEMORY, {
        queueName:   this.queuename,
        workerId:    this._workerId,
        memoryBytes: mem.rss,
        heapUsed:    mem.heapUsed,
        heapTotal:   mem.heapTotal,
      });

      bus.emit(EventType.WORKER_CPU, {
        queueName:  this.queuename,
        workerId:   this._workerId,
        cpuUser:    cpuUserDelta,
        cpuSystem:  cpuSystemDelta,
        cpuPercent: Math.min(100, Math.round(cpuPercent * 10) / 10),
      });
    }, 15_000);

    return origStart.call(this, ...args);
  };

  // ── Worker.work inner job lifecycle → job.active, job.completed, job.failed ─
  WorkerClass.prototype.work = async function(id) {
    const origHandler = this.handler;

    // Wrap the user-provided handler to intercept start/end
    this.handler = async (job) => {
      const isArray = Array.isArray(job);
      const jobs    = isArray ? job : [job];

      for (const j of jobs) {
        const startMs = Date.now();
        this._activeJobTimestamps.set(j.id, startMs);

        // Update status to active in Redis jobs hash
        j.status = 'active';
        try {
          await this.client.hset(`taurusmq:jobs:${this.queuename}`, j.id, JSON.stringify(j));
        } catch (_) {}

        bus.emit(EventType.JOB_ACTIVE, {
          queueName:  this.queuename,
          jobId:      j.id,
          jobName:    j.name,
          workerId:   this._workerId,
          workerHost: this._workerHost,
          attempt:    (j.attempts ?? 0) + 1,
        });

        try {
          const result = await origHandler(isArray ? j : j); // call original
          const durationMs = Date.now() - startMs;
          this._activeJobTimestamps.delete(j.id);

          // Update status to completed in Redis jobs hash
          j.status = 'completed';
          try {
            const pipe = this.client.pipeline();
            pipe.hset(`taurusmq:jobs:${this.queuename}`, j.id, JSON.stringify(j));
            pipe.lpush(`taurusmq:completed:${this.queuename}`, j.id);
            pipe.llen(`taurusmq:completed:${this.queuename}`);
            const results = await pipe.exec();
            const len = results && results[2] && results[2][1];
            if (len > 100) {
              const evictedId = await this.client.rpop(`taurusmq:completed:${this.queuename}`);
              if (evictedId) {
                await this.client.hdel(`taurusmq:jobs:${this.queuename}`, evictedId);
              }
            }
          } catch (_) {}

          bus.emit(EventType.JOB_COMPLETED, {
            queueName: this.queuename,
            jobId:     j.id,
            jobName:   j.name,
            workerId:  this._workerId,
            durationMs,
            attempt:   (j.attempts ?? 0) + 1,
            result:    null, // avoid serializing large results
          });

          return result;
        } catch (err) {
          const durationMs = Date.now() - startMs;
          this._activeJobTimestamps.delete(j.id);

          // Check if retries are paused for this queue
          let isPaused = false;
          try {
            isPaused = await this.client.get(`tmq:obs:paused-retries:${this.queuename}`) === '1';
          } catch (_) {}

          if (isPaused) {
            j.maxretries = 0; // prevent retry, send to DLQ
          }

          const willRetry = !isPaused && (j.attempts ?? 0) < (j.maxretries ?? 3)
            && err.name !== 'Unrecoverable';

          bus.emit(EventType.JOB_FAILED, {
            queueName:    this.queuename,
            jobId:        j.id,
            jobName:      j.name,
            workerId:     this._workerId,
            durationMs,
            attempt:      (j.attempts ?? 0) + 1,
            failedReason: err.message,
            stack:        err.stack ?? null,
            willRetry,
            retryDelayMs: 0, // set by worker after this throw
          });

          throw err; // re-throw so original worker retry logic runs
        }
      }
    };

    return origWork.call(this, id);
  };

  // ── Worker.stop (if implemented) → worker.stopped ────────────────────
  WorkerClass.prototype.stop = function() {
    this.active = false;
    clearInterval(this._heartbeatInterval);
    clearInterval(this._resourceInterval);

    bus.emit(EventType.WORKER_STOPPED, {
      queueName: this.queuename,
      workerId:  this._workerId,
    });
  };
}

module.exports = { patchWorker };
