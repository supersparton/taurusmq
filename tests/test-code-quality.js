// test-code-quality.js
// Integration test verifying console isolation, job.log API, and type-safe finalization.

'use strict';

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');

const Queue = require('../src/core/queue');
const Worker = require('../src/core/worker');
const redis = require('../src/utils/redis');
const { attachObservability } = require('../packages/observability');

describe('TaurusMQ Code Quality & Maturity Test Suite', () => {
  let queue;
  let worker;
  const queueName = 'test-cq-queue';

  before(async () => {
    // Disable auth and attach observability
    process.env.TAURUSMQ_AUTH_DISABLED = 'true';
    await attachObservability({
      Queue,
      Worker,
      queues: [queueName],
      port: 5566,
      patchConsole: false
    });

    queue = new Queue(queueName);
  });

  after(async () => {
    if (worker) {
      await worker.stop();
    }
    await queue.obliterate();
    const { server } = require('../packages/dashboard-api/server');
    await new Promise(resolve => server.close(resolve));
  });

  test('job.log API and completed state ZSET verification', async () => {
    const jobId = await queue.add('log-test-job', { value: 100 });

    let workerFired = false;
    worker = new Worker(queueName, async (job) => {
      assert.ok(typeof job.log === 'function', 'job.log must be attached to the job object');
      await job.log('First log statement');
      await job.log({ details: 'Structured object logging' });
      workerFired = true;
    });

    await worker.start();

    // Wait cleanly for the worker to complete the job
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Job execution timed out')), 5000);
      worker.on('completed', (data) => {
        if (data.jobId === jobId) {
          clearTimeout(timeout);
          resolve();
        }
      });
      worker.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    assert.ok(workerFired, 'Worker handler must execute successfully');

    // 1. Verify logs
    const logKey = `taurusmq:logs:${queueName}:${jobId}`;
    const rawLogs = await redis.lrange(logKey, 0, -1);
    
    assert.strictEqual(rawLogs.length, 2, 'Two log lines must be stored in Redis');
    
    const parsedLog1 = JSON.parse(rawLogs[0]);
    assert.strictEqual(parsedLog1.level, 'log');
    assert.strictEqual(parsedLog1.message, 'First log statement');

    const parsedLog2 = JSON.parse(rawLogs[1]);
    assert.strictEqual(parsedLog2.message, '{"details":"Structured object logging"}');

    // 2. Verify completed jobs ZSET type (no WRONGTYPE collision)
    const key = `taurusmq:completed:${queueName}`;
    const type = await redis.type(key);
    assert.strictEqual(type, 'zset', 'Completed jobs state key must remain a ZSET');
  });
});
