const { v4: uuidv4 } = require('uuid');

class Job {
    constructor(name, data, options = {}) {
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
        this.maxretries = opt.maxretries || 3;
        this.priority = opt.priority || null;
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
        this.queue = null;
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

    async update(data) {
        this.data = data;
        if (this.queue) {
            const prefix = this.queue.prefix;
            const queuename = this.queue.queuename;
            const jobsKey = `${prefix}:jobs:${queuename}`;
            const dlqKey = `${prefix}:dlq:${queuename}`;
            
            const inJobs = await this.queue.client.hexists(jobsKey, this.id);
            if (inJobs) {
                await this.queue.client.hset(jobsKey, this.id, this.toJson());
            } else {
                const inDlq = await this.queue.client.hexists(dlqKey, this.id);
                if (inDlq) {
                    await this.queue.client.hset(dlqKey, this.id, this.toJson());
                }
            }
        }
    }

    async changeDelay(delay) {
        this.delay = delay;
        if (this.queue) {
            const prefix = this.queue.prefix;
            const queuename = this.queue.queuename;
            const jobsKey = `${prefix}:jobs:${queuename}`;
            const delayedKey = `${prefix}:delayed:${queuename}`;
            const signalDelayedKey = `${prefix}:signal:delayed:${queuename}`;
            
            const exists = await this.queue.client.zscore(delayedKey, this.id);
            const executetime = Date.now() + delay;
            this.timestamp = executetime;
            
            if (exists !== null && exists !== undefined) {
                await this.queue.client.zadd(delayedKey, executetime, this.id);
                await this.queue.client.lpush(signalDelayedKey, executetime);
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
            return job;
        } catch (_) {
            return null;
        }
    }
}

module.exports = Job;