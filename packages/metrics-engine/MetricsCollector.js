// packages/metrics-engine/MetricsCollector.js
// Subscribes to the observability bus and updates Redis counters
// for every queue/job/worker event.
//
// Storage schema (all Redis keys prefixed tmq:obs:):
//
//   Counters (HINCRBY, never expire):
//     tmq:obs:metrics:{queue}:counters
//       waiting, active, delayed, failed, completed, created,
//       totalDurationMs, totalCompleted (for avg latency)
//
//   Latency ring buffer (RPUSH + LTRIM to 1000 entries):
//     tmq:obs:metrics:{queue}:latency   — each entry is durationMs as string
//
//   Per-minute throughput (ZINCRBY, 2h TTL):
//     tmq:obs:tp:{queue}:{minuteBucket}  — score = jobs completed in that minute
//
//   Worker state (HSET, 5m TTL):
//     tmq:obs:worker:{workerId}:state    — state hash: queue, host, pid, activeJobs
//     tmq:obs:worker:{workerId}:hb       — last heartbeat ts (string)
//     tmq:obs:worker:{workerId}:res      — memory + cpu hash
//
//   Failure error groups (HINCRBY):
//     tmq:obs:metrics:{queue}:errors     — {errorMessage: count}

'use strict';

const redis        = require('../../src/utils/redis');
const { EventType } = require('../observability-core/types');

const LATENCY_RING_SIZE  = 1000;
const WORKER_STATE_TTL   = 300; // 5 minutes — stale if no heartbeat
const TP_BUCKET_TTL      = 7200; // 2 hours

class MetricsCollector {
  /**
   * @param {import('../observability-core/ObservabilityBus').ObservabilityBus} bus
   */
  constructor(bus) {
    this.bus = bus;
  }

  start() {
    const b = this.bus;

    // ── Job lifecycle events ──────────────────────────────────────────
    b.on(EventType.JOB_CREATED,   (e) => this._onJobCreated(e));
    b.on(EventType.JOB_WAITING,   (e) => this._onJobWaiting(e));
    b.on(EventType.JOB_ACTIVE,    (e) => this._onJobActive(e));
    b.on(EventType.JOB_COMPLETED, (e) => this._onJobCompleted(e));
    b.on(EventType.JOB_FAILED,    (e) => this._onJobFailed(e));
    b.on(EventType.JOB_DELAYED,   (e) => this._onJobDelayed(e));
    b.on(EventType.JOB_RETRY,     (e) => this._onJobRetry(e));
    b.on(EventType.JOB_PROMOTED,  (e) => this._onJobPromoted(e));
    b.on(EventType.JOB_REMOVED,   (e) => this._onJobRemoved(e));

    // ── Worker events ─────────────────────────────────────────────────
    b.on(EventType.WORKER_STARTED,   (e) => this._onWorkerStarted(e));
    b.on(EventType.WORKER_HEARTBEAT, (e) => this._onWorkerHeartbeat(e));
    b.on(EventType.WORKER_MEMORY,    (e) => this._onWorkerMemory(e));
    b.on(EventType.WORKER_CPU,       (e) => this._onWorkerCpu(e));
    b.on(EventType.WORKER_STALLED,   (e) => this._onWorkerStalled(e));
    b.on(EventType.WORKER_STOPPED,   (e) => this._onWorkerStopped(e));

    console.log('[obs] MetricsCollector started');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Job handlers
  // ─────────────────────────────────────────────────────────────────────

  async _onJobCreated({ queueName }) {
    await this._incr(queueName, 'created');
  }

  async _onJobWaiting({ queueName }) {
    await this._incr(queueName, 'waiting');
  }

  async _onJobActive({ queueName }) {
    // Move one from waiting → active
    const pipe = redis.pipeline();
    this._pipeDecr(pipe, this._ckey(queueName), 'waiting');
    pipe.hincrby(this._ckey(queueName), 'active',  1);
    await pipe.exec();
  }

  async _onJobCompleted({ queueName, durationMs, waitingDurationMs }) {
    const minuteBucket = this._minuteBucket();
    const tpKey = `tmq:obs:tp:${queueName}:${minuteBucket}`;

    const dateObj = new Date();
    const yyyymmdd = dateObj.toISOString().slice(0, 10);
    const hourStr = String(dateObj.getUTCHours()).padStart(2, '0');
    const hourKey = `taurusmq:obs:metrics:${queueName}:${yyyymmdd}:hour-${hourStr}`;

    const pipe = redis.pipeline();
    // Counters
    this._pipeDecr(pipe, this._ckey(queueName), 'active');
    pipe.hincrby(this._ckey(queueName), 'completed',       1);
    pipe.hincrby(this._ckey(queueName), 'totalDurationMs', durationMs);
    pipe.hincrby(this._ckey(queueName), 'totalCompleted',  1);
    // Per-minute throughput bucket
    pipe.zincrby(tpKey, 1, 'count');
    pipe.expire(tpKey, TP_BUCKET_TTL);
    // Latency ring buffer
    pipe.rpush(this._latencyKey(queueName), String(durationMs));
    pipe.ltrim(this._latencyKey(queueName), -LATENCY_RING_SIZE, -1);

    // Roll-up analytics
    pipe.hincrby(hourKey, 'processed', 1);
    pipe.hincrbyfloat(hourKey, 'total_duration', durationMs || 0);
    pipe.hincrbyfloat(hourKey, 'total_wait', waitingDurationMs || 0);
    pipe.expire(hourKey, 604800); // 7 days TTL

    await pipe.exec();
  }

  async _onJobFailed({ queueName, failedReason, willRetry, durationMs, waitingDurationMs }) {
    const dateObj = new Date();
    const yyyymmdd = dateObj.toISOString().slice(0, 10);
    const hourStr = String(dateObj.getUTCHours()).padStart(2, '0');
    const hourKey = `taurusmq:obs:metrics:${queueName}:${yyyymmdd}:hour-${hourStr}`;

    const pipe = redis.pipeline();
    this._pipeDecr(pipe, this._ckey(queueName), 'active');
    if (willRetry) {
      pipe.hincrby(this._ckey(queueName), 'delayed', 1);
      pipe.hincrby(this._ckey(queueName), 'retries', 1);
    } else {
      pipe.hincrby(this._ckey(queueName), 'failed',  1);
    }
    // Error group — truncate reason to first 100 chars for grouping key
    const groupKey = (failedReason ?? 'unknown').slice(0, 100);
    pipe.hincrby(`tmq:obs:metrics:${queueName}:errors`, groupKey, 1);

    // Roll-up analytics
    pipe.hincrby(hourKey, 'failed', 1);
    pipe.hincrbyfloat(hourKey, 'total_duration', durationMs || 0);
    pipe.hincrbyfloat(hourKey, 'total_wait', waitingDurationMs || 0);
    pipe.expire(hourKey, 604800); // 7 days TTL

    await pipe.exec();
  }

  async _onJobDelayed({ queueName }) {
    await this._incr(queueName, 'delayed');
  }

  async _onJobRetry({ queueName }) {
    const pipe = redis.pipeline();
    this._pipeDecr(pipe, this._ckey(queueName), 'failed');
    pipe.hincrby(this._ckey(queueName), 'waiting', 1);
    pipe.hincrby(this._ckey(queueName), 'retries', 1);
    await pipe.exec();
  }

  async _onJobPromoted({ queueName }) {
    const pipe = redis.pipeline();
    this._pipeDecr(pipe, this._ckey(queueName), 'delayed');
    pipe.hincrby(this._ckey(queueName), 'waiting', 1);
    await pipe.exec();
  }

  async _onJobRemoved({ queueName }) {
    await this._decr(queueName, 'waiting');
  }

  // ─────────────────────────────────────────────────────────────────────
  // Worker handlers
  // ─────────────────────────────────────────────────────────────────────

  async _onWorkerStarted({ workerId, queueName, workerHost, concurrency, pid }) {
    const stateKey = `tmq:obs:worker:${workerId}:state`;
    await redis.hset(stateKey,
      'queue',       queueName,
      'host',        workerHost,
      'pid',         String(pid),
      'concurrency', String(concurrency),
      'state',       'online',
      'startedAt',   String(Date.now()),
    );
    await redis.expire(stateKey, WORKER_STATE_TTL);
  }

  async _onWorkerHeartbeat({ workerId, activeJobs }) {
    const stateKey = `tmq:obs:worker:${workerId}:state`;
    const hbKey    = `tmq:obs:worker:${workerId}:hb`;

    await redis.pipeline()
      .hset(stateKey, 'activeJobs', JSON.stringify(activeJobs), 'state', 'online')
      .expire(stateKey, WORKER_STATE_TTL)
      .set(hbKey, String(Date.now()))
      .expire(hbKey, WORKER_STATE_TTL)
      .exec();
  }

  async _onWorkerMemory({ workerId, memoryBytes, heapUsed, heapTotal }) {
    const resKey = `tmq:obs:worker:${workerId}:res`;
    await redis.pipeline()
      .hset(resKey,
        'memoryBytes', String(memoryBytes),
        'heapUsed',    String(heapUsed),
        'heapTotal',   String(heapTotal),
        'memTs',       String(Date.now()),
      )
      .expire(resKey, WORKER_STATE_TTL)
      .exec();
  }

  async _onWorkerCpu({ workerId, cpuPercent }) {
    const resKey = `tmq:obs:worker:${workerId}:res`;
    await redis.pipeline()
      .hset(resKey, 'cpuPercent', String(cpuPercent), 'cpuTs', String(Date.now()))
      .expire(resKey, WORKER_STATE_TTL)
      .exec();
  }

  async _onWorkerStalled({ workerId }) {
    const stateKey = `tmq:obs:worker:${workerId}:state`;
    await redis.hset(stateKey, 'state', 'stalled');
    // Don't reset TTL — let it expire naturally if truly dead
  }

  async _onWorkerStopped({ workerId }) {
    const stateKey = `tmq:obs:worker:${workerId}:state`;
    await redis.hset(stateKey, 'state', 'stopped', 'stoppedAt', String(Date.now()));
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────

  _ckey(queueName)      { return `tmq:obs:metrics:${queueName}:counters`; }
  _latencyKey(q)        { return `tmq:obs:metrics:${q}:latency`; }
  _minuteBucket()       { return Math.floor(Date.now() / 60_000); } // unix-minute

  async _incr(queueName, field) {
    await redis.hincrby(this._ckey(queueName), field, 1);
  }
  async _decr(queueName, field) {
    const pipe = redis.pipeline();
    this._pipeDecr(pipe, this._ckey(queueName), field);
    await pipe.exec();
  }

  _pipeDecr(pipe, key, field) {
    pipe.eval("local c=redis.call('HGET',KEYS[1],ARGV[1]); if c and tonumber(c)>0 then return redis.call('HINCRBY',KEYS[1],ARGV[1],-1) else redis.call('HSET',KEYS[1],ARGV[1],0); return 0 end", 1, key, field);
    return pipe;
  }
}

module.exports = { MetricsCollector };
