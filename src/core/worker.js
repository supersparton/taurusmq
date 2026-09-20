const EventEmitter = require('events');
const { getRedisClient } = require("../utils/redis");
const { createLogger } = require("../utils/logger");
const Job = require("./job");
const cron = require('cron-parser');

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Worker extends EventEmitter {
    constructor(queuename, handler , options = {}) {
        super();
        this.queuename = queuename;
        this.prefix = options.prefix || 'taurusmq';
        this.rediskey = `${this.prefix}:${queuename}`;
        this.rediskeyjobs = `${this.prefix}:jobs:${queuename}`;
        this.rediskeysignal = `${this.prefix}:signal:${queuename}`;
        this.rediskeysignaldelayed = `${this.prefix}:signal:delayed:${queuename}`;
        this.rediskeydelayed = `${this.prefix}:delayed:${queuename}`;
        this.rediskeyprioritized = `${this.prefix}:prioritized:${queuename}`;
        this.rediskeyblocked = `${this.prefix}:blocked:${queuename}`;
        this.rediskeydlq = `${this.prefix}:dlq:${queuename}`;
        this.rediskeyactive = `${this.prefix}:active:${queuename}`;
        this.handler = handler;
        this.concurrency = options.concurrency || 1;
        this.running = 0;
        this.active = true;
        this.batchsize = options.batchSize || options.batchsize || 1;
        this.backoffstrategies = options.backoffStrategies || options.backoffstrategies || {};
        this.shutdownTimeout = options.shutdownTimeout || 30000;
        this.limiter = options.limiter || null;
        // publishEvents=false disables Redis per-state event publishes
        // (active/completed/failed/progress/drained) for max throughput.
        // Local EventEmitter emits still fire, and observability (patchWorker
        // → bus) uses local hooks, so the dashboard is unaffected. Default
        // true for QueueEvents back-compat.
        this.publishEvents = options.publishEvents !== false;
        this.options = options;
        this.logger = createLogger(options);

        this.connectionOpts = options.connection;
        this.lockDuration = options.lockDuration || 30000;
        this.lockRenewTime = options.lockRenewTime || Math.floor(this.lockDuration / 2);
        this.activeLockTimers = new Map();
        // Shared non-blocking client for all non-BLPOP operations.
        this.redisClient = getRedisClient(this.connectionOpts);
        // Single fetcher blocking client (Phase 9) — replaces per-slot clients.
        this._fetcherClient = null;
        this._fetcherPromise = null;

        this.paused = false;
        this.resumeResolve = null;
        this.pubsubClient = null;

        // Graceful-shutdown promise machinery
        this._drainResolve = null;
        this._drainPromise = null;
        // Bounded executor pool (Phase 9)
        this._poolRunning = 0;
        this._poolQueue = [];
        // Drain debounce
        this._lastDrainCheck = 0;
        this._drainPending = false;
    }

    async start() {
        this.logger.info(`Worker started for queue ${this.queuename} with concurrency ${this.concurrency}`);

        this.paused = (await this.redisClient.get(`${this.prefix}:paused:${this.queuename}`)) === '1';

        this.pubsubClient = getRedisClient(this.connectionOpts, true);
        await this.pubsubClient.subscribe(`${this.prefix}:pubsub:${this.queuename}`);
        this.pubsubClient.on('message', (channel, message) => {
            if (message === 'pause') {
                this.paused = true;
            } else if (message === 'resume') {
                this.paused = false;
                if (this.resumeResolve) {
                    this.resumeResolve();
                    this.resumeResolve = null;
                }
            }
        });

        // Single fetcher client (3 connections total regardless of concurrency)
        this._fetcherClient = getRedisClient(this.connectionOpts, true);
        await this._fetcherClient.ping();
        this._fetcherPromise = this._fetcher();
    }

    // ── Bounded executor pool ────────────────────────────────────────────
    // Central Redis event publish — no-op when publishEvents is disabled.
    // (QueueEvents subscribers are the only consumers; obs uses local hooks.)
    _publishEvent(payload) {
        if (this.publishEvents === false) return Promise.resolve();
        return this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify(payload));
    }

    _runInPool(fn) {
        const run = async () => {
            this._poolRunning++;
            this.running++;
            try {
                await fn();
            } finally {
                this._poolRunning--;
                this.running--;
                if (this._poolQueue.length > 0) {
                    const next = this._poolQueue.shift();
                    next();
                }
                this._checkDrained();
            }
        };
        if (this._poolRunning < this.concurrency) {
            run();
        } else {
            this._poolQueue.push(run);
        }
    }

    // ── Single fetcher loop (Phase 9) ────────────────────────────────────
    async _fetcher() {
        while (this.active) {
            if (this.paused) {
                await new Promise(resolve => {
                    this.resumeResolve = resolve;
                    if (!this.paused) resolve();
                });
                continue;
            }

            // Backpressure: wait if pool is full
            if (this._poolRunning >= this.concurrency) {
                await sleep(10);
                continue;
            }

            try {
                const blpopResult = await this._fetcherClient.blpop(this.rediskeysignal, 60);
                if (!this.active) break;
                if (!blpopResult) continue;
                if (blpopResult[1] === '__shutdown__') continue;
                if (this.paused) {
                    await this.redisClient.lpush(this.rediskeysignal, 1);
                    continue;
                }
                if (this.limiter) {
                    const now = Date.now();
                    // Unique member per acquisition: same-ms pickups must not
                    // collapse into one ZSET member (see rateLimit.lua ARGV[4]).
                    const attemptId = `${now}:${Math.random().toString(36).slice(2)}`;
                    const [allowed, waitTime] = await this.redisClient.rateLimit(
                        `${this.prefix}:limiter:${this.queuename}`,
                        now,
                        this.limiter.duration,
                        this.limiter.max,
                        attemptId
                    );
                    if (allowed === 0) {
                        await this.redisClient.lpush(this.rediskeysignal, 1);
                        await sleep(waitTime || 10);
                        continue;
                    }
                }

                // Drain-then-block: one BLPOP wakeup feeds a burst of dequeues
                // instead of exactly one job (the old 1-token-1-job loop capped
                // throughput at ~1 job per 2 RTTs no matter the concurrency).
                await this._drainBurst();
            } catch (err) {
                if (!this.active) break;
                // BLPOP throws on disconnect during stop — exit cleanly
                if (err.message && err.message.includes('Connection is closed')) break;
                this.logger.error("Worker fetcher error:", err);
                if (this.active) this.emit('error', err);
                await sleep(100);
            }
        }
    }

    // Drain available jobs without returning to BLPOP between each one.
    // Returns to the blocking wait only when a dequeue comes back empty
    // (plus a stale-token cleanup + racer recatch, see below).
    async _drainBurst() {
        // Limiter set → legacy single dequeue per wakeup. Bursting would
        // admit up to C jobs per single rate check and silently multiply
        // the configured max. Limiter users keep exact current semantics.
        const singleShot = !!this.limiter;
        for (;;) {
            if (!this.active || this.paused) return;
            if (this._poolRunning >= this.concurrency) return;
            const n = await this._dequeueOnce();
            if (n > 0) {
                if (singleShot) return;
                continue;
            }
            // Dequeue came back empty: the burst is over. Producers push one
            // signal token per add but a burst consumes many jobs per wake, so
            // the signal list holds a stale surplus — thousands of tokens would
            // each cause a wasted wake+empty-dequeue cycle. Clear it, then
            // recatch: a job added between the empty dequeue and the DEL is
            // caught here; a job added after carries its own token into BLPOP.
            // Either way no job can strand tokenless.
            try {
                await this.redisClient.del(this.rediskeysignal);
            } catch (_) {}
            if (!this.active || this.paused) return;
            if (this._poolRunning >= this.concurrency) return;
            const m = await this._dequeueOnce();
            if (m === 0) return;
            if (singleShot) return;
        }
    }

    // One dequeue round (batch or single path). Returns jobs fed to the pool.
    async _dequeueOnce() {
                if (this.batchsize > 1) {
                    const batchResult = await this.redisClient.batchdequeue(
                        this.rediskey,
                        `${this.prefix}:active:${this.queuename}`,
                        `${this.prefix}:jobs:${this.queuename}`,
                        this.rediskeyprioritized,
                        this.batchsize,
                        Date.now() + this.lockDuration
                    );
                    if (batchResult && batchResult.length > 0) {
                        const jobs = batchResult.map(JSON.parse);
                        for (const j of jobs) {
                            j.attempts = (j.attempts || 0) + 1;
                            this.emit('active', { jobId: j.id, prev: 'waiting' });
                            const scheduleRenewal = () => {
                                const renewTimer = setTimeout(async () => {
                                    try {
                                        if (!this.active) return;
                                        j.processedOn = Date.now();
                                        const { updateProgress: _fnRenew, ...renewSafe } = j;
                                        const renewJson = JSON.stringify(renewSafe);
                                        await Promise.all([
                                            this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, j.id, renewJson),
                                            this.redisClient.zadd(`${this.prefix}:active:${this.queuename}`, Date.now() + this.lockDuration, j.id)
                                        ]);
                                        scheduleRenewal();
                                    } catch (err) {
                                        this.activeLockTimers.delete(j.id);
                                        if (this.active) this.emit('error', err);
                                    }
                                }, this.lockRenewTime);
                                this.activeLockTimers.set(j.id, renewTimer);
                            };
                            scheduleRenewal();
                        }
                        // One pipelined publish for the whole batch (batchdequeue
                        // lua publishes nothing — this is the sole active signal).
                        if (this.publishEvents !== false && jobs.length > 0) {
                            const pipe = this.redisClient.pipeline();
                            for (const j of jobs) {
                                pipe.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'active', jobId: j.id, prev: 'waiting' }));
                            }
                            await pipe.exec();
                        }
                        this._runInPool(() => this._executeBatch(jobs));
                        return jobs.length;
                    }
                    return 0;
                } else {
                    const jobjson = await this.redisClient.dequeue(
                        this.rediskey,
                        `${this.prefix}:active:${this.queuename}`,
                        `${this.prefix}:jobs:${this.queuename}`,
                        this.rediskeyprioritized,
                        Date.now(),
                        this.lockDuration,
                        // dequeue.lua already guards empty channel (skips PUBLISH)
                        this.publishEvents === false ? '' : `${this.prefix}:${this.queuename}:events`
                    );
                    if (this.options.debug) this.logger.debug(`[Worker Debug] dequeue returned:`, jobjson);
                    if (jobjson) {
                        const job = JSON.parse(jobjson);
                        this._runInPool(() => this._executeJob(job));
                        return 1;
                    }
                    return 0;
                }
    }

    async _executeBatch(jobs) {
        try {
            await this.handler(jobs);
            for (const j of jobs) {
                j.status = "completed";
                const timer = this.activeLockTimers.get(j.id);
                if (timer) { clearTimeout(timer); this.activeLockTimers.delete(j.id); }
                await this.scheduleNextRun(j);
                await this.finalizejob(j);
                // No extra publish: finalizeJob.lua already published 'completed'.
                // (The old duplicate line delivered every batch completion twice.)
                this.emit('completed', { jobId: j.id, returnvalue: j.returnvalue });
            }
        } catch (err) {
            if (this.options.debug) this.logger.debug(`batch job has failed moving to dlq`);
            for (const j of jobs) {
                const timer = this.activeLockTimers.get(j.id);
                if (timer) { clearTimeout(timer); this.activeLockTimers.delete(j.id); }
                j.status = "dead";
                j.failedReason = err.message;
                await this.finalizejob(j);
                // No extra publish: finalizeJob.lua already published 'failed'.
                this.emit('failed', { jobId: j.id, failedReason: err.message });
            }
        }
    }

    async _executeJob(job) {
        this.emit('active', { jobId: job.id, prev: 'waiting' });

        // Lease renewal
        const scheduleRenewal = () => {
            const renewTimer = setTimeout(async () => {
                try {
                    if (!this.active) return;
                    job.processedOn = Date.now();
                    const { updateProgress: _fnRenew, ...renewSafe } = job;
                    const renewJson = JSON.stringify(renewSafe);
                    await Promise.all([
                        this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, renewJson),
                        this.redisClient.zadd(`${this.prefix}:active:${this.queuename}`, Date.now() + this.lockDuration, job.id)
                    ]);
                    scheduleRenewal();
                } catch (err) {
                    this.activeLockTimers.delete(job.id);
                    if (this.active) this.emit('error', err);
                }
            }, this.lockRenewTime);
            this.activeLockTimers.set(job.id, renewTimer);
        };
        scheduleRenewal();

        job.updateProgress = async (value) => {
            job.progress = value;
            try {
                const { updateProgress: _fn, ...safe } = job;
                const safeJson = JSON.stringify(safe);
                await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, safeJson);
                await this._publishEvent({ event: 'progress', jobId: job.id, data: value });
                this.emit('progress', { jobId: job.id, data: value });
            } catch (err) {
                if (this.active) this.emit('error', err);
            }
        };

        let handlerError = null;
        try {
            if (this.options.debug) this.logger.debug(`[Worker Debug] calling handler for job ${job.id}`);
            const returnvalue = await this.handler(job);
            if (this.options.debug) this.logger.debug(`[Worker Debug] handler finished for job ${job.id}`);
            job.returnvalue = (returnvalue !== undefined) ? returnvalue : null;
            job.status = "completed";
            await this.scheduleNextRun(job);
            if (this.options.debug) this.logger.debug(`[Worker Debug] calling finalizejob for job ${job.id}`);
            // NOTE: finalize directly — buffering completions behind a batch
            // barrier was measured -20% throughput (slots idle waiting for
            // peers; ioredis already multiplexes concurrent slots, so batching
            // saves no round trips against single-threaded Redis).
            // Fetch-next piggyback: the same script also dequeues the next job,
            // collapsing finish+fetch into one round trip (nil → BLPOP path).
            const nextJob = await this.finalizeAndFetch(job);
            if (this.options.debug) this.logger.debug(`[Worker Debug] finalizejob finished for job ${job.id}`);
            this.emit('completed', { jobId: job.id, returnvalue: job.returnvalue });
            if (nextJob) {
                this._runInPool(() => this._executeJob(nextJob));
            }
        } catch (err) {
            handlerError = err;
        } finally {
            const timer = this.activeLockTimers.get(job.id);
            if (timer) {
                clearTimeout(timer);
                this.activeLockTimers.delete(job.id);
            }
            if (this.options.debug) this.logger.debug(`[Worker Debug] cleared lock timer for job ${job.id}`);
        }

        if (handlerError) {
            if (this.options.debug) this.logger.debug(`job ${job.id} failed : `, handlerError.message);
            await this.handleFailure(job, handlerError);
        }
        if (this.options.debug) this.logger.debug(`[Worker Debug] iteration complete for job ${job.id}`);
    }

    async stop() {
        this.active = false;

        for (const [jobId, timer] of this.activeLockTimers.entries()) {
            clearTimeout(timer);
        }
        this.activeLockTimers.clear();

        if (this.resumeResolve) {
            this.resumeResolve();
            this.resumeResolve = null;
        }

        // Wake fetcher (1 token, not C)
        try {
            await this.redisClient.lpush(this.rediskeysignal, '__shutdown__');
        } catch (_) {}
        await new Promise(r => setTimeout(r, 100));

        if (this._fetcherClient) {
            try { this._fetcherClient.disconnect(false); } catch (_) {}
            this._fetcherClient = null;
        }

        // Wait for pool to drain
        const shutdownPromises = [];
        if (this._fetcherPromise) {
            const timeoutMs = this.running === 0 ? 500 : this.shutdownTimeout;
            shutdownPromises.push(
                Promise.race([
                    this._fetcherPromise.catch(() => {}),
                    new Promise((resolve) => {
                        const check = () => {
                            if (this.running === 0) resolve();
                            else setTimeout(check, 50);
                        };
                        check();
                        setTimeout(() => {
                            if (this.running > 0) {
                                this.logger.warn(`[TaurusMQ] Worker shutdown timeout (${this.shutdownTimeout}ms) reached with ${this.running} job(s) still running. Force-closing.`);
                            }
                            resolve();
                        }, timeoutMs);
                    })
                ])
            );
        }

        if (this.pubsubClient) {
            const pubsub = this.pubsubClient;
            this.pubsubClient = null;
            shutdownPromises.push(
                Promise.race([
                    pubsub.unsubscribe().then(() => {
                        try { pubsub.disconnect(); } catch (_) {}
                    }).catch(() => {
                        try { pubsub.disconnect(); } catch (_) {}
                    }),
                    new Promise(r => setTimeout(r, 200)),
                ]).catch(() => {
                    try { pubsub.disconnect(); } catch (_) {}
                })
            );
        }

        await Promise.all(shutdownPromises);
        this._fetcherPromise = null;
        this._poolQueue = [];

        // Timers were already cleared at stop() entry; nothing left to clear.
        this.activeLockTimers.clear();

        const redisProxy = require("../utils/redis");
        const connectionIsShared = (this.connectionOpts && typeof this.connectionOpts.duplicate === 'function') || (this.redisClient === redisProxy);
        if (!connectionIsShared && this.redisClient) {
            try { this.redisClient.disconnect(); } catch (_) {}
        }
    }

    // Called after every job completion/failure decrement.
    async _checkDrained() {
        if (!this.active && this.running === 0 && this._drainResolve) {
            const resolve = this._drainResolve;
            this._drainResolve = null;
            resolve();
        }
        if (this.running === 0) {
            const now = Date.now();
            if (now - this._lastDrainCheck < 500) return;
            if (this._drainPending) return;
            this._drainPending = true;
            this._lastDrainCheck = now;

            try {
                const [activeCount, waitCount, prioritizedCount] = await Promise.all([
                    this.redisClient.zcard(`${this.prefix}:active:${this.queuename}`),
                    this.redisClient.llen(`${this.prefix}:${this.queuename}`),
                    this.redisClient.zcard(`${this.prefix}:prioritized:${this.queuename}`)
                ]);
                if (activeCount === 0 && waitCount === 0 && prioritizedCount === 0) {
                    await this._publishEvent({ event: 'drained' });
                    this.emit('drained');
                }
            } catch (err) {
                if (this.active) {
                    this.emit('error', err);
                }
            } finally {
                this._drainPending = false;
            }
        }
    }

    async finalizejob(job) {
        try {
            await this.redisClient.finalizeJob(
                `${this.prefix}:jobs:${this.queuename}`,
                `${this.prefix}:active:${this.queuename}`,
                `${this.prefix}:completed:${this.queuename}`,
                `${this.prefix}:failed:${this.queuename}`,
                this.rediskey,
                this.rediskeyprioritized,
                job.id,
                job.status === 'completed' ? 'completed' : 'dead',
                job.status === 'completed' ? (job.returnvalue !== undefined ? JSON.stringify(job.returnvalue) : "") : (job.failedReason || ""),
                job.progress !== undefined ? String(job.progress) : "",
                Date.now(),
                this.options.removeOnComplete !== undefined ? this.options.removeOnComplete : 1000,
                this.options.removeOnFail !== undefined ? this.options.removeOnFail : 1000,
                this.prefix,
                this.queuename,
                // Omitted by older callers → nil → lua defaults to publishing
                this.publishEvents === false ? '0' : '1',
                // Plain finalize: never fetch-next (failure/batch paths and
                // direct callers keep exact legacy behavior).
                '0',
                Date.now() + this.lockDuration
            );

            await this._postFinalize(job);
        } catch (err) {
            this.emit('error', err);
        }
    }

    // JS-side work after the finalizeJob lua script: DLQ write for dead jobs,
    // DAG unblock / dead-parent cascade, batch counting. Shared by finalizejob
    // and finalizeAndFetch so the piggyback path cannot skip DAG releases.
    async _postFinalize(job) {
        if (job.status === 'dead') {
            await this.redisClient.hset(this.rediskeydlq, job.id, JSON.stringify(job));
        }

        // DAG participants: fan-in children (false), legacy flag (true),
        // fan-out parents/children ('fan-out'). Completion must release
        // jobs blocked on this job via unblock().
        if (job.flow === true || job.flow === false || job.flow === 'fan-out') {
            if (job.status === 'completed') {
                await this.redisClient.unblock(job.id, "parent", "children", this.prefix);
            } else {
                const parents = job.parent || [];
                for (const parentId of parents) {
                    const parentJson = await this.redisClient.hget(`${this.prefix}:jobs:${this.queuename}`, parentId);
                    if (parentJson) {
                        const parentJob = JSON.parse(parentJson);
                        parentJob.status = 'dead';
                        parentJob.failedReason = `child ${job.id} failed: ${job.failedReason || 'unknown error'}`;
                        await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, parentId, JSON.stringify(parentJob));
                        await this.redisClient.hset(this.rediskeydlq, parentId, JSON.stringify(parentJob));
                        await this.redisClient.hdel(`${this.prefix}:blocked:${this.queuename}`, parentId);
                        await this.redisClient.del(`${this.prefix}:job:${parentId}:count`);
                        await this.redisClient.del(`${this.prefix}:job:${parentId}:name`);
                        await this.redisClient.zadd(`${this.prefix}:failed:${this.queuename}`, Date.now(), parentId);
                        await this._publishEvent({
                            event: 'failed', jobId: parentId, failedReason: parentJob.failedReason
                        });
                    }
                }
            }
        }
        if (job.batchid) {
            const remaining = await this.redisClient.decr(`${this.prefix}:batch:${job.batchid}:count`);
            if (parseInt(remaining) === 0) {
                await this.redisClient.del(`${this.prefix}:batch:${job.batchid}:count`);
            }
        }
    }

    // Finalize a successfully completed job AND dequeue the next job in the
    // same round trip (fetch-next piggyback). Returns the parsed next job,
    // or null when the queue is momentarily empty (caller falls back to the
    // blocking BLPOP wait). Piggyback runs only when it is provably safe —
    // paused workers, rate-limited workers, and shutdown keep the plain
    // finalizejob() path with byte-identical legacy behavior.
    async finalizeAndFetch(job) {
        const canPiggyback = this.active && !this.paused && !this.limiter;
        const res = await this.redisClient.finalizeJob(
            `${this.prefix}:jobs:${this.queuename}`,
            `${this.prefix}:active:${this.queuename}`,
            `${this.prefix}:completed:${this.queuename}`,
            `${this.prefix}:failed:${this.queuename}`,
            this.rediskey,
            this.rediskeyprioritized,
            job.id,
            'completed',
            job.returnvalue !== undefined ? JSON.stringify(job.returnvalue) : "",
            job.progress !== undefined ? String(job.progress) : "",
            Date.now(),
            this.options.removeOnComplete !== undefined ? this.options.removeOnComplete : 1000,
            this.options.removeOnFail !== undefined ? this.options.removeOnFail : 1000,
            this.prefix,
            this.queuename,
            this.publishEvents === false ? '0' : '1',
            canPiggyback ? '1' : '0',
            Date.now() + this.lockDuration
        );
        // Shared JS-side post-finalize (DLQ/DAG-unblock/batch counting) —
        // identical to the finalizejob() path, so piggybacked completions
        // release DAG dependents exactly like traditionally finalized ones.
        await this._postFinalize(job);
        const nextJson = Array.isArray(res) ? res[1] : null;
        if (!nextJson) return null;
        return JSON.parse(nextJson);
    }

    async handleFailure(job, err) {
        if (err.name === 'Unrecoverable') {
            job.status = "dead";
            job.failedReason = err.message;
            try {
                await this.finalizejob(job);
                this.emit('failed', { jobId: job.id, failedReason: err.message });
            } catch (err2) {
                if (this.active) this.emit('error', err2);
            }
        } else if (job.attempts < job.maxretries) {
            const delay = this.calculatebackoff(job);
            const nexttime = Date.now() + delay;
            const { updateProgress: _fn, ...jobSafe } = job;
            jobSafe.status = "retrying";
            try {
                await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, JSON.stringify(jobSafe));
                await this.redisClient.zrem(`${this.prefix}:active:${this.queuename}`, job.id);
                await this.redisClient.signal(this.rediskeydelayed, this.rediskeysignaldelayed, nexttime, job.id);
                await this._publishEvent({ event: 'failed', jobId: job.id, failedReason: err.message });
                this.emit('failed', { jobId: job.id, failedReason: err.message });
            } catch (err2) {
                if (this.active) this.emit('error', err2);
            }
        } else {
            job.status = "dead";
            job.failedReason = err.message;
            try {
                await this.finalizejob(job);
                this.emit('failed', { jobId: job.id, failedReason: err.message });
            } catch (err2) {
                if (this.active) this.emit('error', err2);
            }
        }
    }

    async scheduleNextRun(job) {
        if (!job.repeat) return;
        try {
            const interval = cron.CronExpressionParser.parse(job.repeat, {
                currentDate: new Date(job.timestamp)
            });
            const executetime = interval.next().getTime();

            const nextJobData = {
                id: job.id,
                name: job.name,
                data: job.data,
                timestamp: executetime,
                status: 'delayed',
                attempts: 0,
                maxretries: job.maxretries,
                repeat: job.repeat,
                parent: job.parent || [],
                flow: job.flow || null,
                batchid: job.batchid || null,
                delay: null,
                backoff: job.backoff || null,
                processedOn: null,
                progress: null,
                returnvalue: null,
            };

            await this.redisClient.hset(
                `${this.prefix}:jobs:${this.queuename}`,
                job.id,
                JSON.stringify(nextJobData)
            );
            await this.redisClient.signal(
                this.rediskeydelayed,
                this.rediskeysignaldelayed,
                executetime,
                job.id
            );
            this.logger.info(`Scheduled next run for ${new Date(executetime).toLocaleTimeString()} in ${this.prefix}:${this.queuename} of Job ${job.id}`);
        } catch (err) {
            this.logger.error("Cron rescheduling failed:", err.message, `for ${this.prefix}:${this.queuename} of Job ${job.id}`);
        }
    }

    calculatebackoff(job) {
        const backoff = job.backoff || { type: 'fixed', delay: 1000 };
        const attempts = job.attempts;
        if (this.backoffstrategies[backoff.type]) {
            return this.backoffstrategies[backoff.type](attempts, backoff.delay);
        }
        if (backoff.type === 'fixed') {
            return backoff.delay;
        }
        if (backoff.type === 'exponential') {
            return Math.pow(2, attempts - 1) * backoff.delay;
        }
        return 0;
    }
}

module.exports = Worker;
