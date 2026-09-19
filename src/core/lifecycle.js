// src/core/lifecycle.js
'use strict';

/**
 * Close all queues, workers, schedulers, and flow producers in one call.
 * @param {Object} opts
 * @param {Array} opts.queues - Array of Queue instances
 * @param {Array} opts.workers - Array of Worker instances
 * @param {Array} opts.schedulers - Array of Scheduler instances
 * @param {Array} opts.flows - Array of FlowProducer instances
 * @param {Array} opts.events - Array of QueueEvents instances
 */
async function closeAll(opts = {}) {
    const { queues = [], workers = [], schedulers = [], flows = [], events = [] } = opts;

    // Stop workers first (they hold active jobs)
    await Promise.allSettled(workers.map(w => w.stop()));

    // Stop schedulers
    await Promise.allSettled(schedulers.map(s => s.stop()));

    // Close queue events
    await Promise.allSettled(events.map(e => e.close()));

    // Close flow producers
    await Promise.allSettled(flows.map(f => f.close()));

    // Close queues last
    await Promise.allSettled(queues.map(q => q.close()));
}

module.exports = { closeAll };
