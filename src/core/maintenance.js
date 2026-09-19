const { getRedisClient } = require("../utils/redis");
const { createLogger } = require("../utils/logger");

class Maintenance {
    constructor(options = {}) {
        this.prefix = options.prefix || 'taurusmq';
        this.zombieTimeout = options.zombieTimeout || 24 * 60 * 60 * 1000; // default 24 hours
        this.checkInterval = options.checkInterval || 60 * 1000; // default 1 minute
        this.active = true;
        
        this.connectionOpts = options.connection;
        this.redisClient = getRedisClient(this.connectionOpts);
        this.client = getRedisClient(this.connectionOpts, true);
        this.logger = createLogger(options);

        this.maintenanceTimer = null;
        this.maintenanceResolve = null;
        this.zombieTimer = null;
        this.zombieResolve = null;
    }

    async start() {
        this.logger.info(`TaurusMQ Maintenance Engine started.`);
        
        // Run background workers without blocking
        this.runMaintenanceLoop();
        this.runZombieWatchdog();
    }

    async stop() {
        this.active = false;
        if (this.client) {
            this.client.disconnect(false);
        }
        if (this.maintenanceTimer) {
            clearTimeout(this.maintenanceTimer);
            this.maintenanceTimer = null;
        }
        if (this.maintenanceResolve) {
            this.maintenanceResolve();
            this.maintenanceResolve = null;
        }
        if (this.zombieTimer) {
            clearTimeout(this.zombieTimer);
            this.zombieTimer = null;
        }
        if (this.zombieResolve) {
            this.zombieResolve();
            this.zombieResolve = null;
        }

        const redisProxy = require("../utils/redis");
        const connectionIsShared = (this.connectionOpts && typeof this.connectionOpts.duplicate === 'function') || (this.redisClient === redisProxy);
        if (!connectionIsShared && this.redisClient) {
            try { this.redisClient.disconnect(); } catch (_) {}
        }
    }

    // 1. Cascading Deletions (From the _internal queue)
    async runMaintenanceLoop() {
        while (this.active) {
            try {
                // Wait for a task, timeout every 5s so we can check if still active
                const result = await this.client.blpop(`${this.prefix}:_internal:maintenance`, 5);
                if (result) {
                    const task = JSON.parse(result[1]);
                    
                    if (task.type === 'delete') {
                        await this.handleDeletion(task.jobId, task.queue);
                    }
                }
            } catch (err) {
                this.logger.error("Maintenance loop error:", err.message);
                if (this.active) {
                    await new Promise(r => {
                        this.maintenanceResolve = r;
                        this.maintenanceTimer = setTimeout(() => {
                            r();
                            this.maintenanceResolve = null;
                            this.maintenanceTimer = null;
                        }, 5000);
                    });
                }
            }
        }
    }

    async handleDeletion(startJobId, queueName) {
        const idsToDelete = [];
        const queue = [startJobId];
        const visited = new Set([startJobId]);

        // Iterative BFS to find all children without Call Stack Overflow
        while (queue.length > 0) {
            const currentId = queue.shift();
            idsToDelete.push(currentId);

            // SREM this job from its parent's children set (fix orphan refs)
            const parentIds = await this.redisClient.smembers(`${this.prefix}:dependent:${currentId}:parent:`);
            if (parentIds && parentIds.length > 0) {
                const pipeline = this.redisClient.pipeline();
                for (const parentId of parentIds) {
                    pipeline.srem(`${this.prefix}:dependent:${parentId}:children:`, currentId);
                }
                await pipeline.exec();
            }

            const children = await this.redisClient.smembers(`${this.prefix}:dependent:${currentId}:children:`);
            if (children && children.length > 0) {
                for (const childId of children) {
                    if (!visited.has(childId)) {
                        visited.add(childId);
                        queue.push(childId);
                    }
                }
            }
        }

        // Resolve per-job queue names up front (single pipeline — the old
        // code awaited one GET per job while building the delete pipeline)
        const namePipe = this.redisClient.pipeline();
        for (const id of idsToDelete) {
            namePipe.get(`${this.prefix}:job:${id}:name`);
        }
        const nameResults = await namePipe.exec();
        const queueOf = (id, i) => (nameResults?.[i]?.[1]) || queueName;

        // Delete all found jobs atomically using a Pipeline
        const pipeline = this.redisClient.pipeline();

        for (let idx = 0; idx < idsToDelete.length; idx++) {
            const id = idsToDelete[idx];
            // Resolve per-job queue for each job (multi-queue DAG fix)
            const jobQueueName = queueOf(id, idx);

            // A. Clean up Dependencies & Tracking
            pipeline.del(`${this.prefix}:dependent:${id}:children:`);
            pipeline.del(`${this.prefix}:dependent:${id}:parent:`);
            pipeline.del(`${this.prefix}:job:${id}:count`);
            pipeline.del(`${this.prefix}:job:${id}:name`);

            // B. Remove from ALL queue states (using per-job queue name)
            pipeline.lrem(`${this.prefix}:${jobQueueName}`, 0, id);
            pipeline.zrem(`${this.prefix}:delayed:${jobQueueName}`, id);
            pipeline.zrem(`${this.prefix}:active:${jobQueueName}`, id);
            pipeline.zrem(`${this.prefix}:completed:${jobQueueName}`, id);
            pipeline.zrem(`${this.prefix}:failed:${jobQueueName}`, id);
            pipeline.hdel(`${this.prefix}:dlq:${jobQueueName}`, id);
            pipeline.hdel(`${this.prefix}:blocked:${jobQueueName}`, id);

            // C. Remove the actual payload from the Job Vault
            pipeline.hdel(`${this.prefix}:jobs:${jobQueueName}`, id);

            // D. Publish removed event to pubsub channel
            pipeline.publish(`${this.prefix}:${jobQueueName}:events`, JSON.stringify({ event: 'removed', jobId: id }));
        }

        await pipeline.exec();
        this.logger.info(`Maintenance: Purged ${idsToDelete.length} jobs (including dependencies) starting from ${startJobId}`);
    }

    // 2. Zombie Watchdog
    async runZombieWatchdog() {
        while (this.active) {
            try {
                // Scan for any active queues in the system
                let cursor = '0';
                do {
                    const [newCursor, keys] = await this.redisClient.scan(cursor, 'MATCH', `${this.prefix}:active:*`, 'COUNT', 100);
                    cursor = newCursor;

                    for (const activeKey of keys) {
                        const queueName = activeKey.replace(`${this.prefix}:active:`, '');
                        const activeJobs = await this.redisClient.zrange(activeKey, 0, -1, 'WITHSCORES');

                        const now = Date.now();
                        for (let i = 0; i < activeJobs.length; i += 2) {
                            const jobId = activeJobs[i];
                            const leaseExpiry = parseInt(activeJobs[i + 1], 10);

                            // Skip jobs with a valid lease (has an owner)
                            if (leaseExpiry > now) continue;

                            const jobJson = await this.redisClient.hget(`${this.prefix}:jobs:${queueName}`, jobId);

                            if (jobJson) {
                                const job = JSON.parse(jobJson);

                                // If the job has been actively processing for more than zombieTimeout.
                                const activeStartTime = job.processedOn || job.timestamp;
                                if (now - activeStartTime > this.zombieTimeout) {
                                    this.logger.info(`Zombie detected! Job ${jobId} in ${queueName} exceeded timeout. Moving to DLQ.`);
                                    job.status = 'dead';
                                    job.failedReason = 'Zombie timeout exceeded. Worker probably crashed.';

                                    const pipeline = this.redisClient.pipeline();
                                    pipeline.hset(`${this.prefix}:jobs:${queueName}`, jobId, JSON.stringify(job)); // Update vault
                                    pipeline.hset(`${this.prefix}:dlq:${queueName}`, jobId, JSON.stringify(job)); // Store in DLQ
                                    pipeline.zrem(activeKey, jobId); // Remove from active ZSET
                                    pipeline.zadd(`${this.prefix}:failed:${queueName}`, now, jobId); // Add to failed index ZSET
                                    await pipeline.exec();
                                }
                            } else {
                                // Data is gone from vault, but it's stuck in active ZSET
                                this.logger.info(`Maintenance: Removing ghost job ${jobId} from active state.`);
                                await this.redisClient.zrem(activeKey, jobId);
                            }
                        }
                    }
                } while (cursor !== '0');

            } catch(err) {
                this.logger.error("Zombie watchdog error:", err.message);
            }
            
            // Sleep for the interval before checking again
            if (this.active) {
                await new Promise(r => {
                    this.zombieResolve = r;
                    this.zombieTimer = setTimeout(() => {
                        r();
                        this.zombieResolve = null;
                        this.zombieTimer = null;
                    }, this.checkInterval);
                });
            }
        }
    }
}

module.exports = Maintenance;
