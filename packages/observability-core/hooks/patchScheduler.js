// packages/observability-core/hooks/patchScheduler.js
'use strict';

const { EventType } = require('../types');
const redis = require('../../../src/utils/redis');

let patched = false;

/**
 * Patches the Redis promote command to emit JOB_PROMOTED events when
 * delayed jobs are promoted back to the active queue.
 *
 * @param {Function} SchedulerClass
 * @param {Object}   bus
 */
function patchScheduler(SchedulerClass, bus) {
  if (patched) return;
  patched = true;

  const origPromote = redis.promote;
  if (typeof origPromote === 'function') {
    redis.promote = async function(delayedKey, waitingKey, signalKey, nowTime) {
      const promotedJobs = await origPromote.call(redis, delayedKey, waitingKey, signalKey, nowTime);
      
      if (Array.isArray(promotedJobs) && promotedJobs.length > 0) {
        const queueName = delayedKey.replace('taurusmq:delayed:', '');
        for (const jobId of promotedJobs) {
          bus.emit(EventType.JOB_PROMOTED, { queueName, jobId });
        }
      }
      return promotedJobs;
    };
  }
}

module.exports = { patchScheduler };
