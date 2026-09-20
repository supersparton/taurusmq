const { getRedisClient } = require("../utils/redis");
const { createLogger } = require("../utils/logger");
const Job = require("./job");
const cron = require('cron-parser');
const { v4: uuid } = require('uuid');

const crypto = require('crypto');

// Builds a stable, deterministic Redis-safe key for a repeatable job sequence.
// NOTE: priority scoring lives in Lua (addJob/addBulk/promote/...) — the old
// JS calcScore duplicate was deleted; do not reintroduce a second formula.
// Uses sha1(name + cron) to prevent collision when two jobs share the same cron.
// base64url avoids +/=/ characters that break URLs.
function repeatKey(queuename, name, cronExpr) {
    const hash = crypto.createHash('sha1').update(`${name}:${cronExpr}`).digest('hex').slice(0, 12);
    return `repeat:${queuename}:${hash}`;
}

class Queue {
    constructor(queuename, options = {}) {
        this.queuename = queuename;
        this.prefix = options.prefix || 'taurusmq';
        this.rediskey = `${this.prefix}:${queuename}`;
        this.rediskeyjobs = `${this.prefix}:jobs:${queuename}`;
        this.rediskeysignal = `${this.prefix}:signal:${queuename}`;
        this.rediskeysignaldelayed = `${this.prefix}:signal:delayed:${queuename}`;
        this.rediskeyactive = `${this.prefix}:active:${queuename}`;
        this.rediskeydelayed = `${this.prefix}:delayed:${queuename}`;
        this.rediskeyprioritized = `${this.prefix}:prioritized:${queuename}`;
        this.rediskeyblocked = `${this.prefix}:blocked:${queuename}`;
        this.rediskeydlq = `${this.prefix}:dlq:${queuename}`;        
        this.schema = options.schema;
        this.connectionOpts = options.connection;
        this.client = getRedisClient(options.connection);
        this.logger = createLogger(options);
    }
    async add(name, data, options = {}) {
        if (this.schema) {
            const result = this.schema.safeParse(data);
            if (!result.success) {
                throw new Error(`Invalid data for job ${name}: ${result.error.message}`);
            }
        }
        const j = new Job(name, data, options);

        if (j.parent && j.parent.length > 0) {
            // Parent (blocked) path: atomic dedup + store + relationships via Lua
            const result = await this.client.addJob(
                this.rediskeyjobs, this.rediskey, this.rediskeysignal, this.rediskeyprioritized,
                j.id, j.toJson(), j.priority || 0, j.timestamp,
                'parent', this.prefix, this.queuename
            );

            if (result === 0) {
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'deduplicated', jobId: j.id }));
                return { id: j.id, deduplicated: true };
            }

            if (result === 2) {
                // Lua auto-promoted: every parent had already finished, so the
                // child went straight to waiting (signal pushed in-script).
                // Skip promoteIfUnblocked — there is nothing left to promote.
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: j.id }));
                return { id: j.id, deduplicated: false };
            }

            // ── DAG race-condition fix (atomic Lua) ────────────────────────────
            // A parent may finish in the window between addJob and this check.
            // promoteIfUnblocked.lua atomically checks the counter and promotes
            // if all parents already completed — no JS+Redis race window.
            // (Parents finished well before registration are handled inside
            // addJob itself, which returns 2 above.)
            await this.client.promoteIfUnblocked(
                this.rediskeyblocked, this.rediskeyprioritized,
                this.rediskey, this.rediskeysignal,
                j.id, this.prefix, this.queuename,
                j.priority || 0, j.timestamp,
                `${this.prefix}:${this.queuename}:events`
            );

            return { id: j.id, deduplicated: false };
        }
        else if (j.repeat) {
            const interval = cron.CronExpressionParser.parse(j.repeat);
            const executetime = interval.next().getTime();
            const stableId = repeatKey(this.queuename, j.name, j.repeat);
            j.id = stableId;
            j.timestamp = executetime;
            const result = await this.client.addDelayed(
                this.rediskeyjobs, this.rediskeydelayed, this.rediskeysignaldelayed,
                j.id, j.toJson(), executetime,
                `${this.prefix}:${this.queuename}:events`
            );
            if (result === 0) {
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'deduplicated', jobId: stableId }));
                return { id: stableId, deduplicated: true };
            }
            // Maintain repeatable SET index for O(1) reads
            await this.client.sadd(`${this.prefix}:repeatable:${this.queuename}`, stableId);
            return { id: stableId, deduplicated: false };
        }
        else if (j.delay) {
            const executetime = Date.now() + j.delay;
            j.timestamp = executetime;
            const result = await this.client.addDelayed(
                this.rediskeyjobs, this.rediskeydelayed, this.rediskeysignaldelayed,
                j.id, j.toJson(), executetime,
                `${this.prefix}:${this.queuename}:events`
            );
            if (result === 0) {
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'deduplicated', jobId: j.id }));
                return { id: j.id, deduplicated: true };
            }
            return { id: j.id, deduplicated: false };
        }
        else {
            // Immediate path: atomic dedup via Lua
            const result = await this.client.addJob(
                this.rediskeyjobs, this.rediskey, this.rediskeysignal, this.rediskeyprioritized,
                j.id, j.toJson(), j.priority || 0, j.timestamp,
                'immediate'
            );
            if (result === 0) {
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'deduplicated', jobId: j.id }));
                return { id: j.id, deduplicated: true };
            }
            await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: j.id }));
            return { id: j.id, deduplicated: false };
        }
    }
    async addBulk(jobsArray, options = {}) {
        const opt = { ...options };
        if (opt.batchId !== undefined) opt.batchid = opt.batchId;
        if (opt.batchid !== undefined) opt.batchId = opt.batchid;

        const batchid = opt.batchid || `batch:${uuid()}`;
        const exists = await this.client.exists(`${this.prefix}:batch:${batchid}:count`);
        if(exists && opt.batchid) {
            throw new Error(`Batch ID ${batchid} is already in use!`);
        }

        // Flatten jobs into Lua args: [jobId, jobJson, priority, timestamp, mode, ...]
        const luaArgs = [];
        const signalJobs = []; // track delayed items that need signals after script
        for (const item of jobsArray) {
            const { name, data, options: itemOpts } = item;
            const mergedOpts = { ...opt, ...itemOpts };
            // Normalize jobId
            if (mergedOpts.jobId !== undefined) mergedOpts.jobid = mergedOpts.jobId;
            if (mergedOpts.jobid !== undefined) mergedOpts.jobId = mergedOpts.jobid;

            const j = new Job(name, data, mergedOpts);
            j.batchid = batchid;

            let mode = 0; // 0=waiting (priority upgrades to prioritized), 2=delayed
            let executetime = j.timestamp;

            if (j.delay) {
                mode = 2;
                executetime = Date.now() + j.delay;
                j.timestamp = executetime;
                signalJobs.push({ id: j.id, executetime, delay: j.delay });
            }

            luaArgs.push(
                j.id,
                j.toJson(),
                j.priority || 0,
                j.timestamp,
                String(mode)
            );
        }

        if (luaArgs.length === 0) {
            return batchid;
        }

        // Atomic bulk insert with per-item dedup via Lua.
        // Keys: jobs, waiting, prioritized, batchcount, delayed.
        const batchCountKey = `${this.prefix}:batch:${batchid}:count`;
        const results = await this.client.addBulk(
            this.rediskeyjobs, this.rediskey, this.rediskeyprioritized,
            batchCountKey, this.rediskeydelayed,
            luaArgs.length / 5, // batchSize
            ...luaArgs
        );

        // Signal jobs that were actually created (result == 1).
        // One multi-value LPUSH per list: each token wakes one fetcher
        // dequeue and order is irrelevant, so N sequential round-trips
        // collapse into two. (A per-item await loop here cost ~2s per
        // 1000-item batch on typical RTT.)
        const signalById = new Map(signalJobs.map(s => [s.id, s]));
        let createdCount = 0;
        let waitingTokens = 0;
        const delayedTimes = [];
        for (let i = 0; i < results.length; i++) {
            if (results[i] === 1) {
                createdCount++;
                const signalInfo = signalById.get(luaArgs[i * 5]);
                if (signalInfo) {
                    delayedTimes.push(signalInfo.executetime);
                } else {
                    // Waiting / prioritized: wake worker via signal list
                    waitingTokens++;
                }
            }
        }
        if (waitingTokens > 0) {
            await this.client.lpush(this.rediskeysignal, ...new Array(waitingTokens).fill(1));
        }
        if (delayedTimes.length > 0) {
            await this.client.lpush(this.rediskeysignaldelayed, ...delayedTimes);
        }

        // If nothing was created (all duplicates), remove batch counter
        if (createdCount === 0) {
            await this.client.del(batchCountKey);
        }

        return batchid;
    }
    async removeJob(jobId) {
        // Return HDEL-style 0/1 (whether job existed), then queue cascading delete
        const exists = await this.client.hexists(this.rediskeyjobs, jobId);
        const dlqExists = exists ? 0 : await this.client.hexists(this.rediskeydlq, jobId);
        if (!exists && !dlqExists) return 0;
        const task = { type: 'delete', jobId: jobId, queue: this.queuename };
        await this.client.rpush(`${this.prefix}:_internal:maintenance`, JSON.stringify(task));
        return 1;
    }
    async retry(jobId){
        const jobjson = await this.client.hget(this.rediskeydlq,jobId);
        if(!jobjson){
            throw new Error ("Job is not found in dead queue");
        }
        const job = JSON.parse(jobjson);
        job.status = "waiting";
        job.attempts = 0;
        await this.client.retry(this.rediskeydlq, this.rediskey, this.rediskeysignal, this.rediskeyjobs, this.rediskeyprioritized, `${this.prefix}:failed:${this.queuename}`, JSON.stringify(job), jobId);
        await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: jobId }));
        this.logger.info(`${jobId} is retrying..`);
    }
    async pause() {
        await this.client.set(`${this.prefix}:paused:${this.queuename}`, '1');
        await this.client.publish(`${this.prefix}:pubsub:${this.queuename}`, 'pause');
        await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'paused' }));
    }
    async resume() {
        await this.client.del(`${this.prefix}:paused:${this.queuename}`);
        await this.client.publish(`${this.prefix}:pubsub:${this.queuename}`, 'resume');
        await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'resumed' }));
    }
    async isPaused() {
        return (await this.client.get(`${this.prefix}:paused:${this.queuename}`)) === '1';
    }
    async drain() {
        await this.client.drain(
            this.rediskey,
            this.rediskeyprioritized,
            this.rediskeydelayed,
            this.rediskeyjobs,
            this.rediskeysignal,
            this.rediskeysignaldelayed
        );
    }
    async clean(grace, limit, type = 'completed') {
        const now = Date.now();
        let cleanedCount = 0;
        const zsetKey = `${this.prefix}:${type}:${this.queuename}`;
        const cutoff = now - grace;

        // Paginated scan: ZRANGEBYSCORE with LIMIT, compare ZSET score (finishedOn), not vault timestamp
        while (cleanedCount < limit) {
            const batch = await this.client.zrangebyscore(zsetKey, 0, cutoff, 'LIMIT', 0, Math.min(500, limit - cleanedCount));
            if (batch.length === 0) break;

            const pipeline = this.client.pipeline();
            for (const id of batch) {
                pipeline.hdel(this.rediskeyjobs, id);
                pipeline.zrem(zsetKey, id);
                pipeline.del(`${this.prefix}:logs:${this.queuename}:${id}`);
            }
            await pipeline.exec();
            cleanedCount += batch.length;

            if (batch.length < 500) break;
        }
        return cleanedCount;
    }
    async obliterate() {
        const keys = [
            this.rediskey,
            this.rediskeysignal,
            this.rediskeyjobs,
            this.rediskeyactive,
            this.rediskeydelayed,
            this.rediskeysignaldelayed,
            this.rediskeyprioritized,
            this.rediskeyblocked,
            this.rediskeydlq,
            `${this.prefix}:completed:${this.queuename}`,
            `${this.prefix}:failed:${this.queuename}`,
            `${this.prefix}:paused:${this.queuename}`,
            `${this.prefix}:pubsub:${this.queuename}`,
            `tmq:obs:metrics:${this.queuename}:counters`,
            `tmq:obs:metrics:${this.queuename}:latency`,
            `tmq:obs:metrics:${this.queuename}:errors`,
            `tmq:obs:materialized:${this.queuename}`,
            `tmq:obs:metrics:${this.queuename}:history`,
            `tmq:obs:paused-retries:${this.queuename}`,
            `tmq:obs:cost:${this.queuename}:totalUSD`,
            `tmq:obs:cost:${this.queuename}:successfulJobs`,
            `tmq:obs:cost:${this.queuename}:successfulJobCost`,
            `tmq:obs:cost:${this.queuename}:failedJobs`,
            `tmq:obs:cost:${this.queuename}:failedJobCost`,
            `${this.prefix}:repeatable:${this.queuename}`,
            `tmq:obs:events:${this.queuename}`,
            `tmq:obs:incidents:${this.queuename}`,
            `tmq:obs:alerts:${this.queuename}`,
            `tmq:obs:alert_rules:${this.queuename}`,
        ];
        await this.client.del(...keys);
    }
    async getJob(jobId) {
        let json = await this.client.hget(this.rediskeyjobs, jobId);
        // Check DLQ membership regardless of where json came from (dead jobs are in both)
        const inDlq = json ? (await this.client.hexists(this.rediskeydlq, jobId)) : false;
        let dlqJson = null;
        if (!json) {
            dlqJson = await this.client.hget(this.rediskeydlq, jobId);
            if (dlqJson) { json = dlqJson; }
        }
        const isDead = inDlq === 1 || !!dlqJson;
        const job = Job.fromJSON(json);
        if (job) {
            job.queue = this;

            // Derive status live from set membership (vault status is write-only hint)
            if (isDead) {
                job.status = 'dead';
            } else {
                const pipeline = this.client.pipeline();
                pipeline.zscore(this.rediskeyactive, jobId);
                pipeline.zscore(this.rediskeydelayed, jobId);
                pipeline.zscore(`${this.prefix}:completed:${this.queuename}`, jobId);
                pipeline.zscore(`${this.prefix}:failed:${this.queuename}`, jobId);
                pipeline.hexists(this.rediskeyblocked, jobId);
                const results = await pipeline.exec();

                const isActive = results[0][1] !== null;
                const isDelayed = results[1][1] !== null;
                const isCompleted = results[2][1] !== null;
                const isFailed = results[3][1] !== null;
                const isBlocked = results[4][1];

                if (isActive) job.status = 'active';
                else if (isBlocked) job.status = 'blocked';
                else if (isDelayed) job.status = 'delayed';
                else if (isCompleted) job.status = 'completed';
                else if (isFailed) job.status = 'failed';
                // else: waiting (in list) — status stays as vault hint
            }
        }
        return job;
    }
    async getJobs(types, start = 0, end = -1, asc = true) {
        if (!types) {
            types = ['waiting', 'active', 'delayed', 'completed', 'failed', 'blocked'];
        }
        if (!Array.isArray(types)) {
            types = [types];
        }

        let jobIds = [];
        let currentIndex = 0;
        const requestedStart = start;
        const requestedEnd = end === -1 ? Infinity : end;

        for (const type of types) {
            let typeIds = [];
            let count = 0;

            if (type === 'waiting') {
                const prioritizedCount = await this.client.zcard(this.rediskeyprioritized);
                const waitingCount = await this.client.llen(this.rediskey);
                count = prioritizedCount + waitingCount;

                if (currentIndex <= requestedEnd && currentIndex + count > requestedStart) {
                    const localStart = Math.max(0, requestedStart - currentIndex);
                    const localEnd = requestedEnd === Infinity ? -1 : (requestedEnd - currentIndex);

                    let pIds = [];
                    if (localStart < prioritizedCount) {
                        const pEnd = localEnd === -1 ? -1 : Math.min(prioritizedCount - 1, localEnd);
                        pIds = await this.client.zrange(this.rediskeyprioritized, localStart, pEnd);
                    }

                    let wIds = [];
                    const wStart = Math.max(0, localStart - prioritizedCount);
                    if (localEnd === -1 || localEnd >= prioritizedCount) {
                        const wEnd = localEnd === -1 ? -1 : (localEnd - prioritizedCount);
                        wIds = await this.client.lrange(this.rediskey, wStart, wEnd);
                    }
                    typeIds.push(...pIds, ...wIds);
                }
            } else {
                let key = '';
                let isHash = false;
                if (type === 'active') key = this.rediskeyactive;
                else if (type === 'delayed') key = this.rediskeydelayed;
                else if (type === 'failed') key = `${this.prefix}:failed:${this.queuename}`;
                else if (type === 'completed') key = `${this.prefix}:completed:${this.queuename}`;
                else if (type === 'blocked') {
                    key = this.rediskeyblocked;
                    isHash = true;
                } else if (type === 'dead') {
                    // Dead jobs live in the DLQ hash (previously fell through
                    // with key='' and silently returned []).
                    key = this.rediskeydlq;
                    isHash = true;
                }

                if (isHash) {
                    // HSCAN with cursor pagination instead of loading all keys
                    let cursor = '0';
                    const allKeys = [];
                    do {
                        const [newCursor, keys] = await this.client.hscan(key, cursor, 'MATCH', '*', 'COUNT', 100);
                        cursor = newCursor;
                        allKeys.push(...keys.filter((_, i) => i % 2 === 0)); // HSCAN returns [field, value, ...] pairs
                    } while (cursor !== '0');
                    count = allKeys.length;
                    if (currentIndex <= requestedEnd && currentIndex + count > requestedStart) {
                        const localStart = Math.max(0, requestedStart - currentIndex);
                        const localEnd = requestedEnd === Infinity ? count : (requestedEnd - currentIndex + 1);
                        typeIds = allKeys.slice(localStart, localEnd);
                    }
                } else {
                    count = await this.client.zcard(key);
                    if (currentIndex <= requestedEnd && currentIndex + count > requestedStart) {
                        const localStart = Math.max(0, requestedStart - currentIndex);
                        const localEnd = requestedEnd === Infinity ? -1 : (requestedEnd - currentIndex);
                        typeIds = await this.client.zrange(key, localStart, localEnd);
                    }
                }
            }

            jobIds.push(...typeIds);
            currentIndex += count;
            if (currentIndex > requestedEnd) {
                break;
            }
        }

        jobIds = Array.from(new Set(jobIds));

        if (!asc) {
            jobIds.reverse();
        }

        if (jobIds.length === 0) {
            return [];
        }

        // Skip DLQ/blocked lookups for completed/failed types (perf)
        const needsDlq = types.includes('dead') || types.includes('blocked') || types.includes('active') || types.includes('waiting');
        const needsBlocked = types.includes('blocked') || types.includes('active') || types.includes('waiting');

        const results = [];
        const pipeline = this.client.pipeline();
        for (const id of jobIds) {
            pipeline.hget(this.rediskeyjobs, id);
            if (needsDlq) pipeline.hget(this.rediskeydlq, id);
            if (needsBlocked) pipeline.hexists(this.rediskeyblocked, id);
        }
        const raw = await pipeline.exec();

        const opsPerJob = 1 + (needsDlq ? 1 : 0) + (needsBlocked ? 1 : 0);

        for (let i = 0; i < jobIds.length; i++) {
            const mainJson = raw[i * opsPerJob][1];
            const dlqJson = needsDlq ? raw[i * opsPerJob + 1][1] : null;
            const isBlocked = needsBlocked ? raw[i * opsPerJob + (needsDlq ? 2 : 1)][1] : false;
            const json = mainJson || dlqJson;
            if (json) {
                const j = Job.fromJSON(json);
                if (j) {
                    j.queue = this;
                    // Precedence: dead > blocked > active > waiting
                    if (dlqJson && !mainJson) {
                        j.status = 'dead';
                    } else if (isBlocked) {
                        j.status = 'blocked';
                    }
                    results.push(j);
                }
            }
        }

        return results;
    }
    async getJobCounts(...types) {
        const targetTypes = types.length > 0 ? types : ['waiting', 'active', 'delayed', 'completed', 'failed', 'blocked'];
        const counts = {};

        const pipeline = this.client.pipeline();

        if (targetTypes.includes('waiting')) {
            pipeline.llen(this.rediskey);
            pipeline.zcard(this.rediskeyprioritized);
        }
        if (targetTypes.includes('active')) {
            pipeline.zcard(this.rediskeyactive);
        }
        if (targetTypes.includes('delayed')) {
            pipeline.zcard(this.rediskeydelayed);
        }
        if (targetTypes.includes('failed')) {
            pipeline.zcard(`${this.prefix}:failed:${this.queuename}`);
        }
        if (targetTypes.includes('blocked')) {
            pipeline.hlen(this.rediskeyblocked);
        }
        if (targetTypes.includes('completed')) {
            pipeline.zcard(`${this.prefix}:completed:${this.queuename}`);
        }

        const results = await pipeline.exec();
        let resultIndex = 0;

        if (targetTypes.includes('waiting')) {
            const listLen = results[resultIndex++][1] || 0;
            const zsetLen = results[resultIndex++][1] || 0;
            counts.waiting = listLen + zsetLen;
        }
        if (targetTypes.includes('active')) {
            counts.active = results[resultIndex++][1] || 0;
        }
        if (targetTypes.includes('delayed')) {
            counts.delayed = results[resultIndex++][1] || 0;
        }
        if (targetTypes.includes('failed')) {
            counts.failed = results[resultIndex++][1] || 0;
        }
        if (targetTypes.includes('blocked')) {
            counts.blocked = results[resultIndex++][1] || 0;
        }
        if (targetTypes.includes('completed')) {
            counts.completed = results[resultIndex++][1] || 0;
        }

        return counts;
    }
    async removeRepeatable(repeatKeyOrCron) {
        let stableId = repeatKeyOrCron;
        if (!repeatKeyOrCron.startsWith('repeat:')) {
            // repeatKeyOrCron is cron expression: need job name to compute stable id
            // Try to find matching repeatable job by cron
            const all = await this.getRepeatableJobs();
            const match = all.find(j => j.cron === repeatKeyOrCron);
            if (match) stableId = match.key;
            else stableId = repeatKey(this.queuename, 'default', repeatKeyOrCron);
        }
        
        const pipeline = this.client.pipeline();
        pipeline.hdel(this.rediskeyjobs, stableId);
        pipeline.zrem(this.rediskeydelayed, stableId);
        pipeline.zrem(this.rediskeyactive, stableId);
        pipeline.lrem(this.rediskey, 0, stableId);
        pipeline.srem(`${this.prefix}:repeatable:${this.queuename}`, stableId);
        
        await pipeline.exec();
    }
    async getRepeatableJobs() {
        const repeatableIds = await this.client.smembers(`${this.prefix}:repeatable:${this.queuename}`);
        
        if (repeatableIds.length === 0) {
            return [];
        }
        
        const pipeline = this.client.pipeline();
        for (const id of repeatableIds) {
            pipeline.hget(this.rediskeyjobs, id);
            pipeline.zscore(this.rediskeydelayed, id);
        }
        const results = await pipeline.exec();
        
        const output = [];
        for (let i = 0; i < repeatableIds.length; i++) {
            const id = repeatableIds[i];
            const jobJson = results[i * 2][1];
            const scoreVal = results[i * 2 + 1][1];
            if (jobJson) {
                try {
                    const job = JSON.parse(jobJson);
                    output.push({
                        key: id,
                        name: job.name,
                        cron: job.repeat,
                        next: scoreVal ? parseInt(scoreVal, 10) : null
                    });
                } catch (_) {}
            }
        }
        return output;
    }
    async close() {
        if (this.client) {
            const isSharedInstance = this.connectionOpts && typeof this.connectionOpts.duplicate === 'function';
            const redisProxy = require("../utils/redis");
            if (!isSharedInstance && this.client !== redisProxy) {
                try {
                    await this.client.quit();
                } catch (_) {}
            }
        }
    }
}

module.exports = Queue;