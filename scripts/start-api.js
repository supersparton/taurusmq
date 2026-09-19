'use strict';

// Production entrypoint: observability API ONLY (no demo workload).
//
//   OBS_PORT         — API listen port (default 4000)
//   TAURUSMQ_QUEUES  — comma-separated seed queue names (default "default")
//   REDIS_URL        — picked up by src/utils/redis (default localhost:6379)
//
// Queues beyond the seed list are auto-discovered from bus events
// (see startObservabilityStack in packages/dashboard-api/server.js).

const { Queue, Worker, Scheduler } = require('../src/index');
const { attachObservability } = require('../packages/observability');

async function main() {
  const port = parseInt(process.env.OBS_PORT ?? '4000', 10);
  const queues = (process.env.TAURUSMQ_QUEUES ?? 'default')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const stack = await attachObservability({
    Queue,
    Worker,
    Scheduler,
    queues,
    port,
    patchConsole: false,
  });

  const { server } = require('../packages/dashboard-api/server');

  let shuttingDown = false;
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${sig} received — shutting down`);
    try {
      stack.aggregator.stop();
    } catch (_) {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[api] fatal:', err);
  process.exit(1);
});
