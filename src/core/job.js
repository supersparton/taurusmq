const { v4: uuidv4 } = require('uuid');

class Job {
    constructor(name, data, options = {}) {
        // Validate required fields
        if (!name || typeof name !== 'string') {
            throw new Error('Job name is required and must be a string');
        }

        this.name = name;
        this.data = data;
        
        // Normalize option keys to support both camelCase and lowercase (backwards compatibility)
        const opt = { ...options };
        if (opt.jobId !== undefined) opt.jobid = opt.jobId;
        if (opt.jobid !== undefined) opt.jobId = opt.jobid;
        if (opt.maxRetries !== undefined) opt.maxretries = opt.maxRetries;
        if (opt.batchId !== undefined) opt.batchid = opt.batchId;
        if (opt.batchid !== undefined) opt.batchId = opt.batchid;
        if (opt.dependsOnChild !== undefined) opt.dependsonchild = opt.dependsOnChild;

        // Honour a caller-supplied jobId for deduplication; fall back to uuid.
        this.id = opt.jobId || uuidv4();
        this.timestamp = Date.now();
        this.status = 'waiting';
        this.attempts = 0;

        // Validate and clamp maxretries (allow 0)
        const maxRetries = opt.maxretries ?? 3;
        this.maxretries = Math.max(0, Math.min(100, maxRetries));

        // Validate priority
        const priority = opt.priority || null;
        if (priority !== null && (typeof priority !== 'number' || priority < 0)) {
            throw new Error('Priority must be a non-negative number');
        }
        this.priority = priority;
        // options.repeat is the cron expression for repeatable jobs.
        // Previously hardcoded to null — this was the root cause of all delayed/repeat jobs
        // falling through to immediate execution.
        this.repeat = opt.repeat || null;
        this.parent = opt.parent || [];
        this.flow = (opt.flow !== undefined) ? opt.flow : ((opt.dependsonchild !== undefined) ? opt.dependsonchild : null);
        this.batchid = opt.batchid || null;
        this.delay = opt.delay || null;
        this.backoff = opt.backoff || null;
        // processedOn — set by the worker the moment the job is dequeued for execution.
        // Used by stall watchdogs to measure active duration accurately.
        // Distinct from timestamp (creation time). Null until the job is first picked up.
        this.processedOn = null;
        // Progress tracking — updated in-flight by the worker via updateProgress()
        this.progress = null;
        // Return value — written by the worker after the handler resolves
        this.returnvalue = null;
        // queue is non-enumerable to avoid circular JSON serialization
        Object.defineProperty(this, 'queue', { value: null, writable: true, enumerable: false });
    }
    toJson() {
        return JSON.stringify({
            id: this.id,
            name: this.name,
            data: this.data,
            timestamp: this.timestamp,
            status: this.status,
            attempts: this.attempts,
            maxretries: this.maxretries,
            priority: this.priority,
            repeat: this.repeat,
            parent: this.parent,
            flow: this.flow,
            batchid: this.batchid,
            delay: this.delay,
            backoff: this.backoff,
            processedOn: this.processedOn,
            progress: this.progress,
            returnvalue: this.returnvalue,
        });
    }

    async changeDelay(delay) {
        this.delay = delay;
        if (this.queue) {
            const prefix = this.queue.prefix;
            const queuename = this.queue.queuename;
            const jobsKey = `${prefix}:jobs:${queuename}`;
            const waitingKey = `${prefix}:${queuename}`;
            const delayedKey = `${prefix}:delayed:${queuename}`;
            const signalDelayedKey = `${prefix}:signal:delayed:${queuename}`;
            
            const inDelayed = await this.queue.client.zscore(delayedKey, this.id);
            const inWaiting = await this.queue.client.lpos(waitingKey, this.id);
            const executetime = Date.now() + delay;
            this.timestamp = executetime;
            
            if (inDelayed !== null && inDelayed !== undefined) {
                // Already delayed — update score
                await this.queue.client.zadd(delayedKey, executetime, this.id);
                await this.queue.client.lpush(signalDelayedKey, executetime);
            } else if (inWaiting !== null && inWaiting !== undefined) {
                // Waiting → delayed transition: remove from list, add to delayed ZSET
                await this.queue.client.lrem(waitingKey, 0, this.id);
                await this.queue.client.zadd(delayedKey, executetime, this.id);
                await this.queue.client.lpush(signalDelayedKey, executetime);
            } else {
                const e = new Error(`Job ${this.id} is not in waiting or delayed state — cannot change delay`);
                e.name = 'InvalidState';
                throw e;
            }
            
            await this.queue.client.hset(jobsKey, this.id, this.toJson());
        }
    }

    static fromJSON(jsonStr) {
        if (!jsonStr) return null;
        try {
            const data = JSON.parse(jsonStr);
            const job = new Job(data.name, data.data, {
                jobId: data.id,
                maxretries: data.maxretries,
                priority: data.priority,
                repeat: data.repeat,
                parent: data.parent,
                dependsonchild: data.flow,
                batchid: data.batchid,
                delay: data.delay,
                backoff: data.backoff,
            });
            job.timestamp = data.timestamp;
            job.status = data.status;
            job.attempts = data.attempts;
            job.processedOn = data.processedOn;
            job.progress = data.progress;
            job.returnvalue = data.returnvalue;
            job.failedReason = data.failedReason || null;
            job.finishedOn = data.finishedOn || null;
            return job;
        } catch (err) {
            try { require('../utils/logger').createLogger({}).error('corrupt job payload, skipping:', err.message); } catch (_) {}
            return null;
        }
    }
}

module.exports = Job;