// Shared harness for Phase-0 tests: one disposable Redis per test FILE,
// unique key prefix per TEST for isolation.
//
// src/ is CommonJS, so it is loaded via createRequire. Test files import
// this helper as ESM.

import { GenericContainer } from 'testcontainers';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getRedisClient } = require('../../../src/utils/redis');
const Queue = require('../../../src/core/queue');

let container = null;
let redisUrl = null;

export async function startRedisOnce() {
  if (redisUrl) return redisUrl;
  container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return redisUrl;
}

export async function stopRedisOnce() {
  try {
    await container?.stop();
  } catch (_) {}
  container = null;
  redisUrl = null;
}

export function uniquePrefix(tag) {
  return `t${tag}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// Raw client with all Lua commands defined (defineCommands runs on construction).
export function rawClient(url) {
  return getRedisClient(url);
}

export function makeQueue(queueName, url, prefix) {
  return new Queue(queueName, { connection: url, prefix });
}

export async function quitAll(...clients) {
  for (const c of clients) {
    try {
      await c?.quit();
    } catch (_) {}
  }
}

export { getRedisClient, Queue };
