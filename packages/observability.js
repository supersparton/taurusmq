// packages/observability.js
// Single entry point to attach the full observability stack to TaurusMQ.
//
// Usage:
//
//   // Configure TAURUSMQ_USERNAME and TAURUSMQ_PASSWORD in environment variables
//
//   const Queue  = require('./src/core/queue');
//   const Worker = require('./src/core/worker');
//   const { attachObservability } = require('./packages/observability');
//
//   await attachObservability({
//     Queue,
//     Worker,
//     queues:   ['email-notifications', 'image-processing'],
//     port:     3333,
//   });
//
//   // Then use Queue and Worker as normal.
//   // Open http://localhost:3333 in your browser.

'use strict';

const path                = require('path');
const { bus }             = require('./observability-core');
const { patchQueue }      = require('./observability-core/hooks/patchQueue');
const { patchWorker }     = require('./observability-core/hooks/patchWorker');
const { patchScheduler }  = require('./observability-core/hooks/patchScheduler');
const { SetupManager }    = require('./observability-core/SetupManager');
const { startObservabilityStack } = require('./dashboard-api/server');

/**
 * @param {Object}    opts
 * @param {Function}  opts.Queue       - Queue class from src/core/queue.js
 * @param {Function}  opts.Worker      - Worker class from src/core/worker.js
 * @param {Function}  [opts.Scheduler] - Scheduler class from src/core/scheduler.js
 * @param {string[]}  [opts.queues]    - known queue names at startup (more auto-discovered)
 * @param {number}    [opts.port]      - dashboard API port (default: 4000)
 * @param {string}    [opts.projectRoot] - override project root (default: cwd)
 */
async function attachObservability({
  Queue,
  Worker,
  Scheduler,
  queues      = [],
  port        = parseInt(process.env.OBS_PORT ?? '4000', 10),
  projectRoot = process.cwd(),
}) {
  // 1. Initialize credentials in memory
  const setup     = new SetupManager(projectRoot);
  const creds     = await setup.setup();
  const jwtSecret = creds.jwtSecret;

  // 2. Patch Queue, Worker, and Scheduler to emit observability events
  patchQueue(Queue, bus);
  patchWorker(Worker, bus);

  const SchedulerClass = Scheduler || require('../src/core/scheduler');
  if (SchedulerClass) {
    patchScheduler(SchedulerClass, bus);
  }

  // 3. Start API server with auth wired in
  await startObservabilityStack(queues, setup, jwtSecret, port);

  console.log('[obs] ─────────────────────────────────────────');
  console.log(`[obs] TaurusMQ Observability running`);
  console.log(`[obs] API    → http://localhost:${port}`);
  console.log(`[obs] Login  → POST http://localhost:${port}/api/auth/login`);
  console.log(`[obs] User   → ${creds.username}`);
  console.log('[obs] ─────────────────────────────────────────');
}

module.exports = { attachObservability, bus };
