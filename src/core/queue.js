const { getRedisClient } = require("../utils/redis");
const Job = require("./job");
const cron = require('cron-parser');
const { v4: uuid } = require('uuid');

// Builds a stable, deterministic Redis-safe key for a repeatable job sequence.
// Using base64 of the cron string avoids special characters (*/-, spaces) in keys.
function repeatKey(queuename, cronExpr) {
    return `repeat:${queuename}:${Buffer.from(cronExpr).toString('base64')}`;
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
    }
    async add(name, data, options = {}) {
        if (this.schema) {
            const result = this.schema.safeParse(data);
            if (!result.success) {
                throw new Error(`Invalid data for job ${name}: ${result.error.message}`);
            }
        }
        const j = new Job(name, data, options);

        // ── Deduplication: if jobId already exists in the jobs hash, bail out ──
        if (options.jobId) {
            const existing = await this.client.hexists(this.rediskeyjobs, j.id);
            if (existing) {
                return j.id; // idempotent — return the pre-existing id
            }
        }

        if (j.parent && j.parent.length > 0) {
            // Store the job payload first
            await this.client.hset(this.rediskeyjobs, j.id, j.toJson());
            // Mark as blocked
            await this.client.hset(this.rediskeyblocked, j.id, 1);

            // Use a pipeline for all relationship writes to minimise round-trips
            const pipeline = this.client.pipeline();
            pipeline.set(`${this.prefix}:job:${j.id}:count`, j.parent.length);
            pipeline.set(`${this.prefix}:job:${j.id}:name`, this.queuename);
            for (let i = 0; i < j.parent.length; i++) {
                pipeline.sadd(`${this.prefix}:dependent:${j.parent[i]}:children:`, j.id);
                pipeline.sadd(`${this.prefix}:dependent:${j.id}:parent:`, j.parent[i]);
            }
            await pipeline.exec();

            // ── DAG race-condition fix ──────────────────────────────────────────
            // A parent may have already finished before we registered this child.
            // Re-read the counter; if it has dropped to 0 or below (because unblock
            // already fired for some parents) promote the job to waiting immediately.
            const currentCount = await this.client.get(`${this.prefix}:job:${j.id}:count`);
            if (parseInt(currentCount, 10) <= 0) {
                await this.client.hdel(this.rediskeyblocked, j.id);
                await this.client.del(`${this.prefix}:job:${j.id}:count`);
                await this.client.del(`${this.prefix}:job:${j.id}:name`);
                if (j.priority && j.priority > 0) {
                    const score = j.priority * 100000000000 + (j.timestamp - 1700000000000);
                    await this.client.zadd(this.rediskeyprioritized, score, j.id);
                } else {
                    await this.client.rpush(this.rediskey, j.id);
                }
                await this.client.lpush(this.rediskeysignal, 1);
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: j.id }));
            }

            return j.id;
        }
        else if (j.repeat) {
            const interval = cron.CronExpressionParser.parse(j.repeat);
            const executetime = interval.next().getTime();
            const stableId = repeatKey(this.queuename, j.repeat);
            j.id = stableId;
            j.timestamp = executetime;
            await this.client.hset(this.rediskeyjobs, stableId, j.toJson());
            const existsDelayed = await this.client.zscore(this.rediskeydelayed, stableId);
            if (!existsDelayed) {
                await this.client.signal(this.rediskeydelayed, this.rediskeysignaldelayed, executetime, stableId);
                await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'delayed', jobId: stableId, delay: executetime - Date.now() }));
            }
            return stableId;
        }
        else if (j.delay) {
            const executetime = Date.now() + j.delay;
            j.timestamp = executetime;
            await this.client.hset(this.rediskeyjobs, j.id, j.toJson());
            await this.client.signal(this.rediskeydelayed, this.rediskeysignaldelayed, executetime, j.id);
            await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'delayed', jobId: j.id, delay: j.delay }));
            console.log(`Job ${j.id} scheduled for ${new Date(executetime).toLocaleTimeString()}`);
        }
        else {
            await this.client.addJob(
                this.rediskeyjobs,
                this.rediskey,
                this.rediskeysignal,
                this.rediskeyprioritized,
                j.id,
                j.toJson(),
                j.priority || 0,
                j.timestamp
            );
            await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: j.id }));
        }
        return j.id;
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

        const customIds = [];
        for (const item of jobsArray) {
            if (item.options) {
                const itemOpt = { ...item.options };
                if (itemOpt.jobId !== undefined) itemOpt.jobid = itemOpt.jobId;
                if (itemOpt.jobid !== undefined) itemOpt.jobId = itemOpt.jobid;
                if (itemOpt.jobId) {
                    customIds.push(itemOpt.jobId);
                }
            }
        }

        const existingSet = new Set();
        if (customIds.length > 0) {
            const existingStatuses = await this.client.hmget(this.rediskeyjobs, ...customIds);
            for (let i = 0; i < customIds.length; i++) {
                if (existingStatuses[i] !== null && existingStatuses[i] !== undefined) {
                    existingSet.add(customIds[i]);
                }
            }
        }

        const jobsToEnqueue = [];
        for (const item of jobsArray) {
            const itemOpt = item.options || {};
            const jobId = itemOpt.jobId || itemOpt.jobid || null;
            if (jobId && existingSet.has(jobId)) {
                continue; // Skip pre-existing job
            }
            jobsToEnqueue.push(item);
        }

        if (jobsToEnqueue.length === 0) {
            console.log("bulk: all jobs already exist. Nothing to enqueue.");
            return batchid;
        }

        const pipeline = this.client.pipeline();
        pipeline.set(`${this.prefix}:batch:${batchid}:count`, jobsToEnqueue.length);
        pipeline.expire(`${this.prefix}:batch:${batchid}:count`, 7 * 24 * 60 * 60);
        for(let i=0;i<jobsToEnqueue.length;i++){
            const { name, data, options: itemOpts } = jobsToEnqueue[i];
            const j = new Job(name, data, itemOpts);
            j.batchid = batchid;
            pipeline.hset(this.rediskeyjobs,j.id,j.toJson());
            if (j.priority && j.priority > 0) {
                const score = j.priority * 100000000000 + (j.timestamp - 1700000000000);
                pipeline.zadd(this.rediskeyprioritized, score, j.id);
            } else {
                pipeline.rpush(this.rediskey,j.id);
            }
            pipeline.lpush(this.rediskeysignal,1);
            pipeline.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: j.id }));
        }
        await pipeline.exec();
        console.log("bulk running successfully on",this.rediskey);
        return batchid;
    }
    async addbulk(jobsarray, options = {}) {
        return this.addBulk(jobsarray, options);
    }
    async removeJob(jobId) {
        const task = { type: 'delete', jobId: jobId, queue: this.queuename };
        await this.client.rpush(`${this.prefix}:_internal:maintenance`, JSON.stringify(task));
        console.log(`Task ${jobId} safely queued for background deletion.`);
        return true;
    }
    async retry(jobId){
        const jobjson = await this.client.hget(this.rediskeydlq,jobId);
        if(!jobjson){
            throw new Error ("Job is not found in dead queue");
        }
        const job = JSON.parse(jobjson);
        job.status = "waiting";
        job.attempts = 0;
        await this.client.retry(this.rediskeydlq, this.rediskey, this.rediskeysignal, this.rediskeyjobs, this.rediskeyprioritized, JSON.stringify(job), jobId);
        await this.client.publish(`${this.prefix}:${this.queuename}:events`, JSON.stringify({ event: 'waiting', jobId: jobId }));
        console.log(`${jobId} is retrying..`);
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
        const jobIds = await this.client.zrange(zsetKey, 0, -1);
        
        if (jobIds.length === 0) return 0;
        
        const pipeline = this.client.pipeline();
        for (const id of jobIds) {
            pipeline.hget(this.rediskeyjobs, id);
        }
        const rawJobs = await pipeline.exec();
        
        const deletePipeline = this.client.pipeline();
        for (let i = 0; i < jobIds.length; i++) {
            if (cleanedCount >= limit) break;
            const jobId = jobIds[i];
            const jobJson = rawJobs[i][1];
            if (jobJson) {
                try {
                    const job = JSON.parse(jobJson);
                    if (now - job.timestamp > grace) {
                        deletePipeline.hdel(this.rediskeyjobs, jobId);
                        deletePipeline.zrem(zsetKey, jobId);
                        deletePipeline.del(`${this.prefix}:logs:${this.queuename}:${jobId}`);
                        cleanedCount++;
                    }
                } catch (err) {
                    deletePipeline.hdel(this.rediskeyjobs, jobId);
                    deletePipeline.zrem(zsetKey, jobId);
                    deletePipeline.del(`${this.prefix}:logs:${this.queuename}:${jobId}`);
                    cleanedCount++;
                }
            } else {
                deletePipeline.zrem(zsetKey, jobId);
            }
        }
        await deletePipeline.exec();
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
        ];
        await this.client.del(...keys);
    }
    async getJob(jobId) {
        let json = await this.client.hget(this.rediskeyjobs, jobId);
        if (!json) {
            json = await this.client.hget(this.rediskeydlq, jobId);
        }
        const job = Job.fromJSON(json);
        if (job) {
            job.queue = this;
            const isBlocked = await this.client.hexists(this.rediskeyblocked, jobId);
            if (isBlocked) {
                job.status = 'blocked';
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
                }

                if (isHash) {
                    const allKeys = await this.client.hkeys(key);
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

        const results = [];
        const pipeline = this.client.pipeline();
        for (const id of jobIds) {
            pipeline.hget(this.rediskeyjobs, id);
            pipeline.hget(this.rediskeydlq, id);
            pipeline.hexists(this.rediskeyblocked, id);
        }
        const raw = await pipeline.exec();

        for (let i = 0; i < jobIds.length; i++) {
            const mainJson = raw[i * 3][1];
            const dlqJson = raw[i * 3 + 1][1];
            const isBlocked = raw[i * 3 + 2][1];
            const json = mainJson || dlqJson;
            if (json) {
                const j = Job.fromJSON(json);
                if (j) {
                    j.queue = this;
                    if (isBlocked) {
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
    async updateJob(jobId, data) {
        const job = await this.getJob(jobId);
        if (job) {
            await job.update(data);
            return job;
        }
        return null;
    }
    async changeJobDelay(jobId, delay) {
        const job = await this.getJob(jobId);
        if (job) {
            await job.changeDelay(delay);
            return job;
        }
        return null;
    }
    async removeRepeatable(repeatKeyOrCron) {
        let stableId = repeatKeyOrCron;
        if (!repeatKeyOrCron.startsWith('repeat:')) {
            stableId = repeatKey(this.queuename, repeatKeyOrCron);
        }
        
        const pipeline = this.client.pipeline();
        pipeline.hdel(this.rediskeyjobs, stableId);
        pipeline.zrem(this.rediskeydelayed, stableId);
        pipeline.zrem(this.rediskeyactive, stableId);
        pipeline.lrem(this.rediskey, 0, stableId);
        
        await pipeline.exec();
    }
    async getRepeatableJobs() {
        const allJobs = await this.client.hgetall(this.rediskeyjobs);
        const repeatableIds = Object.keys(allJobs).filter(key => key.startsWith(`repeat:${this.queuename}:`));
        
        if (repeatableIds.length === 0) {
            return [];
        }
        
        const pipeline = this.client.pipeline();
        for (const id of repeatableIds) {
            pipeline.zscore(this.rediskeydelayed, id);
        }
        const scores = await pipeline.exec();
        
        const results = [];
        for (let i = 0; i < repeatableIds.length; i++) {
            const id = repeatableIds[i];
            const scoreVal = scores[i][1];
            try {
                const job = JSON.parse(allJobs[id]);
                results.push({
                    key: id,
                    name: job.name,
                    cron: job.repeat,
                    next: scoreVal ? parseInt(scoreVal, 10) : null
                });
            } catch (_) {}
        }
        return results;
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