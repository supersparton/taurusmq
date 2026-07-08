// packages/observability-core/hooks/patchWorker.js
// Wraps Worker prototype methods to emit job.active, job.completed, job.failed,
// worker.heartbeat, worker.memory, worker.cpu events.

'use strict';

const os            = require('os');
const { EventType } = require('../types');

const { AsyncLocalStorage } = require('async_hooks');

const jobLogStorage = new AsyncLocalStorage();
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
let isConsolePatched = false;

function patchConsole() {
  if (isConsolePatched) return;
  isConsolePatched = true;

  console.log = function(...args) {
    origLog.apply(console, args);
    const context = jobLogStorage.getStore();
    if (context) {
      context.logs.push({ level: 'log', message: args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '), ts: Date.now() });
    }
  };

  console.warn = function(...args) {
    origWarn.apply(console, args);
    const context = jobLogStorage.getStore();
    if (context) {
      context.logs.push({ level: 'warn', message: args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '), ts: Date.now() });
    }
  };

  console.error = function(...args) {
    origError.apply(console, args);
    const context = jobLogStorage.getStore();
    if (context) {
      context.logs.push({ level: 'error', message: args.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' '), ts: Date.now() });
    }
  };
}

/**
 * @param {Function} WorkerClass  - Worker constructor from src/core/worker.js
 * @param {Object}   bus          - ObservabilityBus singleton
 * @param {Object}   [options]    - Optional settings
 */
function patchWorker(WorkerClass, bus, options = {}) {
  if (options.patchConsole !== false && process.env.TAURUSMQ_DISABLE_CONSOLE_PATCH !== 'true') {
    patchConsole();
  }
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
  WorkerClass.prototype.work = async function(id, slotClient) {
    const origHandler = this.handler;

    // Wrap the user-provided handler to intercept start/end
    this.handler = async (job) => {
      const prefix  = this.prefix || 'taurusmq';
      const isArray = Array.isArray(job);
      const jobs    = isArray ? job : [job];

      for (const j of jobs) {
        const startMs = Date.now();
        this._activeJobTimestamps.set(j.id, startMs);

        // Update status to active in Redis jobs hash
        j.status = 'active';
        j.processedOn = startMs;
        j.timeline = j.timeline || [];
        // Make sure we have the initial queued event
        if (!j.timeline.some((e) => e.event === 'queued')) {
          j.timeline.push({ event: 'queued', ts: j.timestamp ?? startMs - 100 });
        }
        j.timeline.push({ event: 'picked', ts: startMs - 5, worker: this._workerId });
        j.timeline.push({ event: 'started', ts: startMs });

        // Capture system resources for snapshotting
        let cpuUsage = 0;
        try {
          const usage = process.cpuUsage();
          cpuUsage = Math.round((usage.user + usage.system) / 10000) % 100;
        } catch (_) {}

        j.snapshot = {
          cpu: cpuUsage,
          memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
          env: {
            NODE_ENV: process.env.NODE_ENV || 'development',
          },
          redis: {
            status: this.redisClient.status || 'ready',
          },
        };

        try {
          await this.redisClient.hset(`${prefix}:jobs:${this.queuename}`, j.id, JSON.stringify(j));
        } catch (_) {}

        bus.emit(EventType.JOB_ACTIVE, {
          queueName:  this.queuename,
          jobId:      j.id,
          jobName:    j.name,
          workerId:   this._workerId,
          workerHost: this._workerHost,
          attempt:    j.attempts ?? 1,
        });

        const logContext = { jobId: j.id, logs: [] };
        j.log = async (message) => {
          try {
            const logLine = {
              level: 'log',
              message: typeof message === 'object' ? JSON.stringify(message) : String(message),
              ts: Date.now()
            };
            logContext.logs.push(logLine);
            const logKey = `${prefix}:logs:${this.queuename}:${j.id}`;
            await this.redisClient.rpush(logKey, JSON.stringify(logLine));
            await this.redisClient.expire(logKey, 7 * 24 * 3600);
          } catch (_) {}
        };

        try {
          const result = await jobLogStorage.run(logContext, async () => {
            return await origHandler(isArray ? j : j);
          });
          const durationMs = Date.now() - startMs;
          this._activeJobTimestamps.delete(j.id);

          // Update status to completed in Redis jobs hash
          j.status = 'completed';
          j.finishedOn = Date.now();
          j.duration = durationMs;
          // Persist the handler's return value so it's readable from the dashboard
          j.returnvalue = (result !== undefined) ? result : null;
          j.timeline = j.timeline || [];
          j.timeline.push({ event: 'completed', ts: Date.now(), durationMs });

          // Save logs to Redis
          if (logContext.logs.length > 0) {
            try {
              const logKey = `${prefix}:logs:${this.queuename}:${j.id}`;
              await this.redisClient.del(logKey);
              await this.redisClient.rpush(logKey, ...logContext.logs.map((log) => JSON.stringify(log)));
              await this.redisClient.expire(logKey, 7 * 24 * 3600); // 7 days TTL
            } catch (_) {}
          }

          try {
            // Strip the updateProgress function before serialising
            const { updateProgress: _drop, ...jobData } = j;
            await this.redisClient.hset(`${prefix}:jobs:${this.queuename}`, j.id, JSON.stringify(jobData));
          } catch (_) {}

          bus.emit(EventType.JOB_COMPLETED, {
            queueName: this.queuename,
            jobId:     j.id,
            jobName:   j.name,
            workerId:  this._workerId,
            durationMs,
            waitingDurationMs: startMs - (j.timestamp ?? startMs),
            attempt:   j.attempts ?? 1,
            result,  // actual return value, not null
          });

          return result;
        } catch (err) {
          const durationMs = Date.now() - startMs;
          this._activeJobTimestamps.delete(j.id);

          // Update failure metrics on the job object
          j.status = 'failed';
          j.finishedOn = Date.now();
          j.duration = durationMs;
          j.timeline = j.timeline || [];
          j.timeline.push({ event: 'failed', ts: Date.now(), durationMs });
          j.stacktrace = err.stack ? err.stack.split('\n') : [err.message];
          j.failedReason = err.message;

          // Save logs to Redis
          if (logContext.logs.length > 0) {
            try {
              const logKey = `${prefix}:logs:${this.queuename}:${j.id}`;
              await this.redisClient.del(logKey);
              await this.redisClient.rpush(logKey, ...logContext.logs.map((log) => JSON.stringify(log)));
              await this.redisClient.expire(logKey, 7 * 24 * 3600); // 7 days TTL
            } catch (_) {}
          }

          // Check if retries are paused for this queue
          let isPaused = false;
          try {
            isPaused = await this.redisClient.get(`tmq:obs:paused-retries:${this.queuename}`) === '1';
          } catch (_) {}

          if (isPaused) {
            j.maxretries = 0; // prevent retry, send to DLQ
          }

          const willRetry = !isPaused && (j.attempts ?? 0) < (j.maxretries ?? 3)
            && err.name !== 'Unrecoverable';

          try {
            // Strip updateProgress before serialising to Redis
            const { updateProgress: _drop, ...jobData } = j;
            await this.redisClient.hset(`${prefix}:jobs:${this.queuename}`, j.id, JSON.stringify(jobData));
          } catch (_) {}

          bus.emit(EventType.JOB_FAILED, {
            queueName:    this.queuename,
            jobId:        j.id,
            jobName:      j.name,
            workerId:     this._workerId,
            durationMs,
            waitingDurationMs: startMs - (j.timestamp ?? startMs),
            attempt:      j.attempts ?? 1,
            failedReason: err.message,
            stack:        err.stack ?? null,
            willRetry,
            retryDelayMs: 0, // set by worker after this throw
          });

          throw err; // re-throw so original worker retry logic runs
        }
      }
    };

    return origWork.call(this, id, slotClient);
  };

  // ── Worker.stop (if implemented) → worker.stopped ────────────────────
  const origStop = WorkerClass.prototype.stop;
  WorkerClass.prototype.stop = async function() {
    if (origStop) {
      await origStop.call(this);
    } else {
      this.active = false;
    }
    clearInterval(this._heartbeatInterval);
    clearInterval(this._resourceInterval);

    bus.emit(EventType.WORKER_STOPPED, {
      queueName: this.queuename,
      workerId:  this._workerId,
    });
  };
}

module.exports = { patchWorker };
