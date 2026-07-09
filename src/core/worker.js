const EventEmitter = require('events');
const { getRedisClient } = require("../utils/redis");
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
        // Graceful shutdown: wait up to this many ms for running jobs before force-closing.
        this.shutdownTimeout = options.shutdownTimeout || 30000;
        this.limiter = options.limiter || null;
        this.options = options;

        this.connectionOpts = options.connection;
        // Lock lease options for stall prevention
        this.lockDuration = options.lockDuration || 30000;
        this.lockRenewTime = options.lockRenewTime || Math.floor(this.lockDuration / 2);
        this.activeLockTimers = new Map();
        // Shared non-blocking client for all non-BLPOP operations.
        this.redisClient = getRedisClient(this.connectionOpts);
        // Per-slot blocking clients — allocated in start(), one per concurrency slot.
        this._slotClients = [];

        this.paused = false;
        this.resumeResolve = null;
        this.pubsubClient = null;

        // Graceful-shutdown promise machinery
        this._drainResolve = null;
        this._drainPromise = null;
        this._slotPromises = [];
    }

    async start() {
        console.log(`Worker started for queue ${this.queuename} with concurrency ${this.concurrency}`);

        // Fetch initial paused state
        this.paused = (await this.redisClient.get(`${this.prefix}:paused:${this.queuename}`)) === '1';

        // Subscribe to pause/resume pubsub (dedicated blocking connection)
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

        // Allocate one dedicated blocking connection per concurrency slot.
        const pings = [];
        for (let i = 0; i < this.concurrency; i++) {
            const slotClient = getRedisClient(this.connectionOpts, true);
            this._slotClients.push(slotClient);
            pings.push(slotClient.ping().then(() => i + 1));
        }
        const resolvedSlots = await Promise.all(pings);
        for (const slotId of resolvedSlots) {
            const slotClient = this._slotClients[slotId - 1];
            this._slotPromises.push(this.work(slotId, slotClient));
        }
    }

    async stop() {
        // Signal work loops to exit after their current iteration
        this.active = false;

        // Clear all active lock renewal timers
        for (const [jobId, timer] of this.activeLockTimers.entries()) {
            clearInterval(timer);
        }
        this.activeLockTimers.clear();

        // Wake any slot that is suspended waiting for a resume signal
        if (this.resumeResolve) {
            this.resumeResolve();
            this.resumeResolve = null;
        }

        // Wake idle slots so they exit blpop quickly instead of waiting 60s.
        try {
            if (this.concurrency > 0) {
                const pipe = this.redisClient.pipeline();
                for (let i = 0; i < this.concurrency; i++) {
                    pipe.rpush(this.rediskeysignal, '__shutdown__');
                }
                await pipe.exec();
                // Allow a brief moment for the shutdown signals to be delivered to blocked clients
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (_) {}

        // Disconnect per-slot blocking clients to abort active blpop calls immediately.
        for (const slotClient of this._slotClients) {
            try { slotClient.disconnect(false); } catch (_) {}
        }

        // ── Graceful drain: wait for all worker slot loops to finish ─────────────
        const shutdownPromises = [];
        if (this._slotPromises && this._slotPromises.length > 0) {
            const timeoutMs = (this.running === 0) ? 500 : this.shutdownTimeout;
            shutdownPromises.push(
                Promise.race([
                    Promise.all(this._slotPromises),
                    new Promise((resolve) => {
                        setTimeout(() => {
                            if (this.running > 0) {
                                console.warn(`[TaurusMQ] Worker shutdown timeout (${this.shutdownTimeout}ms) reached with ${this.running} job(s) still running. Force-closing.`);
                            }
                            resolve();
                        }, timeoutMs);
                    })
                ])
            );
        }

        // Unsubscribe and disconnect pubsub client in parallel with a short timeout
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
        this._slotPromises = [];
        this._slotClients = [];

        // Clear all active lock renewal timers again, just in case any were added during shutdown
        for (const [jobId, timer] of this.activeLockTimers.entries()) {
            clearInterval(timer);
        }
        this.activeLockTimers.clear();

        const redisProxy = require("../utils/redis");
        const connectionIsShared = (this.connectionOpts && typeof this.connectionOpts.duplicate === 'function') || (this.redisClient === redisProxy);
        if (!connectionIsShared && this.redisClient) {
            try { this.redisClient.disconnect(); } catch (_) {}
        }
    }

    async work(id, slotClient) {
        while (this.active) {
            if (this.paused) {
                await new Promise(resolve => {
                    this.resumeResolve = resolve;
                    if (!this.paused) resolve();
                });
                continue;
            }

            let job = null;
            if (this.batchsize > 1) {
                try {
                    const blpopResult = await slotClient.blpop(this.rediskeysignal, 60);
                    if (!blpopResult) continue; // timeout
                    if (blpopResult[1] === '__shutdown__') continue;
                    if (this.paused) {
                        await this.redisClient.lpush(this.rediskeysignal, 1);
                        continue;
                    }
                    if (this.limiter) {
                        const now = Date.now();
                        const [allowed, waitTime] = await this.redisClient.rateLimit(
                            `${this.prefix}:limiter:${this.queuename}`,
                            now,
                            this.limiter.duration,
                            this.limiter.max
                        );
                        if (allowed === 0) {
                            await this.redisClient.lpush(this.rediskeysignal, 1);
                            await sleep(waitTime || 10);
                            continue;
                        }
                    }
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
                            await this.scheduleNextRun(j);
                            await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'active', jobId: j.id, prev: 'waiting' }));
                            this.emit('active', { jobId: j.id, prev: 'waiting' });
                        }
                        try {
                            this.running += jobs.length;
                            await this.handler(jobs);
                            for (const j of jobs) {
                                j.status = "completed";
                                await this.finalizejob(j);
                                await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'completed', jobId: j.id, returnvalue: j.returnvalue }));
                                this.emit('completed', { jobId: j.id, returnvalue: j.returnvalue });
                                this.running--;
                                this._checkDrained();
                            }
                        } catch (err) {
                            console.log(`batch job has failed moving to dlq`);
                            for (const j of jobs) {
                                j.status = "dead";
                                j.failedReason = err.message;
                                await this.finalizejob(j);
                                await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: j.id, failedReason: err.message }));
                                this.emit('failed', { jobId: j.id, failedReason: err.message });
                                this.running--;
                                this._checkDrained();
                            }
                        }
                    }
                    continue;
                } catch (err) {
                    console.log(`batch job error:`, err.message);
                    this.emit('error', err);
                    continue;
                }
            }

            try {
                console.log(`[Worker Debug] [Slot Loop] calling blpop on key: ${this.rediskeysignal}`);
                const blpopResult = await slotClient.blpop(this.rediskeysignal, 60);
                console.log(`[Worker Debug] [Slot Loop] blpop returned:`, blpopResult);
                if (!blpopResult) continue; // timeout
                if (blpopResult[1] === '__shutdown__') {
                    console.log(`[Worker Debug] [Slot Loop] shutdown signal received`);
                    continue;
                }
                if (this.paused) {
                    await this.redisClient.lpush(this.rediskeysignal, 1);
                    continue;
                }
                if (this.limiter) {
                    const now = Date.now();
                    const [allowed, waitTime] = await this.redisClient.rateLimit(
                        `${this.prefix}:limiter:${this.queuename}`,
                        now,
                        this.limiter.duration,
                        this.limiter.max
                    );
                    if (allowed === 0) {
                        await this.redisClient.lpush(this.rediskeysignal, 1);
                        await sleep(waitTime || 10);
                        continue;
                    }
                }
                console.log(`[Worker Debug] [Slot Loop] calling dequeue LUA on key: ${this.rediskey}`);
                const jobjson = await this.redisClient.dequeue(
                    this.rediskey,
                    `${this.prefix}:active:${this.queuename}`,
                    `${this.prefix}:jobs:${this.queuename}`,
                    this.rediskeyprioritized,
                    Date.now() + this.lockDuration
                );
                console.log(`[Worker Debug] [Slot Loop] dequeue returned:`, jobjson);
                if (jobjson) {
                    this.running++;
                    job = JSON.parse(jobjson);
                    job.attempts++;
                    job.processedOn = Date.now();
                    const { updateProgress: _fnInit, ...initialSafe } = job;
                    const initialJson = JSON.stringify(initialSafe);
                    await Promise.all([
                        this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'active', jobId: job.id, prev: 'waiting' })),
                        this.redisClient.zadd(`${this.prefix}:active:${this.queuename}`, Date.now() + this.lockDuration, job.id),
                        this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, initialJson)
                    ]);
                    this.emit('active', { jobId: job.id, prev: 'waiting' });

                    // Start periodic lease renewal timer
                    const renewTimer = setInterval(async () => {
                        try {
                            if (!this.active) {
                                clearInterval(renewTimer);
                                return;
                            }
                            job.processedOn = Date.now();
                            const { updateProgress: _fnRenew, ...renewSafe } = job;
                            const renewJson = JSON.stringify(renewSafe);
                            await Promise.all([
                                this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, renewJson),
                                this.redisClient.zadd(`${this.prefix}:active:${this.queuename}`, Date.now() + this.lockDuration, job.id)
                            ]);
                        } catch (err) {
                            clearInterval(renewTimer);
                            this.activeLockTimers.delete(job.id);
                            if (this.active) {
                                this.emit('error', err);
                            }
                        }
                    }, this.lockRenewTime);
                    this.activeLockTimers.set(job.id, renewTimer);

                    // Attach updateProgress so the handler can report progress.
                    job.updateProgress = async (value) => {
                        job.progress = value;
                        try {
                            const { updateProgress: _fn, ...safe } = job;
                            const safeJson = JSON.stringify(safe);
                            await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, safeJson);
                            await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'progress', jobId: job.id, data: value }));
                            this.emit('progress', { jobId: job.id, data: value });
                        } catch (err) {
                            if (this.active) {
                                this.emit('error', err);
                            }
                        }
                    };

                    await this.scheduleNextRun(job);

                    let handlerError = null;
                    try {
                        console.log(`[Worker Debug] calling handler for job ${job.id}`);
                        const returnvalue = await this.handler(job);
                        console.log(`[Worker Debug] handler finished for job ${job.id}`);
                        job.returnvalue = (returnvalue !== undefined) ? returnvalue : null;
                        job.status = "completed";
                        console.log(`[Worker Debug] calling finalizejob for job ${job.id}`);
                        await this.finalizejob(job);
                        console.log(`[Worker Debug] finalizejob finished for job ${job.id}`);
                        await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'completed', jobId: job.id, returnvalue: job.returnvalue }));
                        this.emit('completed', { jobId: job.id, returnvalue: job.returnvalue });
                        console.log(`[Worker Debug] published completed event for job ${job.id}`);
                    } catch (err) {
                        handlerError = err;
                    } finally {
                        const timer = this.activeLockTimers.get(job.id);
                        if (timer) {
                            clearInterval(timer);
                            this.activeLockTimers.delete(job.id);
                        }
                        console.log(`[Worker Debug] cleared lock timer for job ${job.id}`);
                    }

                    if (handlerError) {
                        console.log(`job ${job.id} failed : `, handlerError.message);
                        const { updateProgress: _fn, ...jobSafe } = job;
                        if (handlerError.name === 'Unrecoverable') {
                            job.status = "dead";
                            job.failedReason = handlerError.message;
                            try {
                                await this.finalizejob(job);
                                await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: handlerError.message }));
                                this.emit('failed', { jobId: job.id, failedReason: handlerError.message });
                            } catch (err2) {
                                if (this.active) {
                                    this.emit('error', err2);
                                }
                            }
                        } else if (job.attempts < job.maxretries) {
                            const delay = this.calculatebackoff(job);
                            const nexttime = Date.now() + delay;
                            console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries}) in ${delay / 1000} sec..`);
                            jobSafe.status = "retrying";
                            try {
                                await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, JSON.stringify(jobSafe));
                                await this.redisClient.zrem(`${this.prefix}:active:${this.queuename}`, job.id);
                                await this.redisClient.signal(this.rediskeydelayed, this.rediskeysignaldelayed, nexttime, job.id);
                                await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: handlerError.message }));
                                this.emit('failed', { jobId: job.id, failedReason: handlerError.message });
                            } catch (err2) {
                                if (this.active) {
                                    this.emit('error', err2);
                                }
                            }
                        } else {
                            console.log(`Job ${job.id} hit max retries, moving to dlq`);
                            job.status = "dead";
                            job.failedReason = handlerError.message;
                            try {
                                await this.finalizejob(job);
                                await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: handlerError.message }));
                                this.emit('failed', { jobId: job.id, failedReason: handlerError.message });
                            } catch (err2) {
                                if (this.active) {
                                    this.emit('error', err2);
                                }
                            }
                        }
                    }

                    this.running--;
                    this._checkDrained();
                    console.log(`[Worker Debug] iteration complete for job ${job.id}`);
                }
            } catch (err) {
                console.error("Worker loop error:", err);
                if (this.active) {
                    this.emit('error', err);
                }
                if (job) {
                    console.log(`job ${job.id} failed : `, err.message);
                    const { updateProgress: _fn, ...jobSafe } = job;
                    if (err.name === 'Unrecoverable') {
                        job.status = "dead";
                        job.failedReason = err.message;
                        try {
                            await this.finalizejob(job);
                            await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: err.message }));
                            this.emit('failed', { jobId: job.id, failedReason: err.message });
                        } catch (err2) {
                            if (this.active) {
                                this.emit('error', err2);
                            }
                        }
                        this.running--;
                        this._checkDrained();
                        continue;
                    }
                    if (job.attempts < job.maxretries) {
                        const delay = this.calculatebackoff(job);
                        const nexttime = Date.now() + delay;
                        console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries}) in ${delay / 1000} sec..`);
                        jobSafe.status = "retrying";
                        try {
                            await this.redisClient.hset(`${this.prefix}:jobs:${this.queuename}`, job.id, JSON.stringify(jobSafe));
                            await this.redisClient.zrem(`${this.prefix}:active:${this.queuename}`, job.id);
                            await this.redisClient.signal(this.rediskeydelayed, this.rediskeysignaldelayed, nexttime, job.id);
                            await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: err.message }));
                            this.emit('failed', { jobId: job.id, failedReason: err.message });
                        } catch (err2) {
                            if (this.active) {
                                this.emit('error', err2);
                            }
                        }
                    } else {
                        console.log(`Job ${job.id} hit max retries, moving to dlq`);
                        job.status = "dead";
                        job.failedReason = err.message;
                        try {
                            await this.finalizejob(job);
                            await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'failed', jobId: job.id, failedReason: err.message }));
                            this.emit('failed', { jobId: job.id, failedReason: err.message });
                        } catch (err2) {
                            if (this.active) {
                                this.emit('error', err2);
                            }
                        }
                    }
                    this.running--;
                    this._checkDrained();
                }
            }
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
            try {
                const [activeCount, waitCount, prioritizedCount] = await Promise.all([
                    this.redisClient.zcard(`${this.prefix}:active:${this.queuename}`),
                    this.redisClient.llen(`${this.prefix}:${this.queuename}`),
                    this.redisClient.zcard(`${this.prefix}:prioritized:${this.queuename}`)
                ]);
                if (activeCount === 0 && waitCount === 0 && prioritizedCount === 0) {
                    await this.redisClient.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'drained' }));
                    this.emit('drained');
                }
            } catch (err) {
                if (this.active) {
                    this.emit('error', err);
                }
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
                job.id,
                job.status === 'completed' ? 'completed' : 'dead',
                job.status === 'completed' ? (job.returnvalue !== undefined ? JSON.stringify(job.returnvalue) : "") : (job.failedReason || ""),
                job.progress !== undefined ? String(job.progress) : "",
                Date.now(),
                this.options.removeOnComplete !== undefined ? this.options.removeOnComplete : 1000,
                this.options.removeOnFail !== undefined ? this.options.removeOnFail : 1000,
                this.prefix,
                this.queuename
            );

            if (job.status === 'dead') {
                await this.redisClient.hset(this.rediskeydlq, job.id, JSON.stringify(job));
            }

            if (job.flow === true || job.flow === false) {
                await this.redisClient.unblock(job.id, "parent", "children", this.prefix);
            }
            if (job.batchid) {
                const remaining = await this.redisClient.decr(`${this.prefix}:batch:${job.batchid}:count`);
                if (parseInt(remaining) === 0) {
                    console.log(`Batch Completed: ${job.batchid}`);
                    await this.redisClient.del(`${this.prefix}:batch:${job.batchid}:count`);
                }
            }
        } catch (err) {
            this.emit('error', err);
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
            console.log(`Scheduled next run for ${new Date(executetime).toLocaleTimeString()} in ${this.prefix}:${this.queuename} of Job ${job.id}`);
        } catch (err) {
            console.error("Cron rescheduling failed:", err.message, `for ${this.prefix}:${this.queuename} of Job ${job.id}`);
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
