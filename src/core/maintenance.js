const { getRedisClient } = require("../utils/redis");

class Maintenance {
    constructor(options = {}) {
        this.prefix = options.prefix || 'taurusmq';
        this.zombieTimeout = options.zombieTimeout || 24 * 60 * 60 * 1000; // default 24 hours
        this.checkInterval = options.checkInterval || 60 * 1000; // default 1 minute
        this.active = true;
        
        this.connectionOpts = options.connection;
        this.redisClient = getRedisClient(this.connectionOpts);
        this.client = getRedisClient(this.connectionOpts, true);

        this.maintenanceTimer = null;
        this.maintenanceResolve = null;
        this.zombieTimer = null;
        this.zombieResolve = null;
    }

    async start() {
        console.log(`🧹 TaurusMQ Maintenance Engine started.`);
        
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
                console.error("Maintenance loop error:", err.message);
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

        // Delete all found jobs atomically using a Pipeline
        const pipeline = this.redisClient.pipeline();
        
        for (const id of idsToDelete) {
            // A. Clean up Dependencies & Tracking
            pipeline.del(`${this.prefix}:dependent:${id}:children:`);
            pipeline.del(`${this.prefix}:dependent:${id}:parent:`);
            pipeline.del(`${this.prefix}:job:${id}:count`);
            pipeline.del(`${this.prefix}:job:${id}:name`);
            
            // B. Remove from ALL queue states
            pipeline.lrem(`${this.prefix}:${queueName}`, 0, id); 
            pipeline.zrem(`${this.prefix}:delayed:${queueName}`, id);
            pipeline.zrem(`${this.prefix}:active:${queueName}`, id);
            pipeline.zrem(`${this.prefix}:completed:${queueName}`, id);
            pipeline.zrem(`${this.prefix}:failed:${queueName}`, id);
            pipeline.hdel(`${this.prefix}:dlq:${queueName}`, id);
            pipeline.hdel(`${this.prefix}:blocked:${queueName}`, id);
            
            // C. Remove the actual payload from the Job Vault
            pipeline.hdel(`${this.prefix}:jobs:${queueName}`, id);
            
            // D. Publish removed event to pubsub channel
            pipeline.publish(`${this.prefix}:${queueName}:events`, JSON.stringify({ event: 'removed', jobId: id }));
        }

        await pipeline.exec();
        console.log(`🧹 Maintenance: Purged ${idsToDelete.length} jobs (including dependencies) starting from ${startJobId}`);
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
                        const activeJobs = await this.redisClient.zrange(activeKey, 0, -1);
                        
                        const now = Date.now();
                        for (const jobId of activeJobs) {
                            const jobJson = await this.redisClient.hget(`${this.prefix}:jobs:${queueName}`, jobId);
                            
                            if (jobJson) {
                                const job = JSON.parse(jobJson);
                                
                                // If the job has been actively processing for more than zombieTimeout.
                                const activeStartTime = job.processedOn || job.timestamp;
                                if (now - activeStartTime > this.zombieTimeout) {
                                    console.log(`🧟 Zombie detected! Job ${jobId} in ${queueName} exceeded timeout. Moving to DLQ.`);
                                    job.status = 'dead';
                                    job.error = 'Zombie timeout exceeded. Worker probably crashed.';
                                    
                                    const pipeline = this.redisClient.pipeline();
                                    pipeline.hset(`${this.prefix}:jobs:${queueName}`, jobId, JSON.stringify(job)); // Update vault
                                    pipeline.hset(`${this.prefix}:dlq:${queueName}`, jobId, JSON.stringify(job)); // Store in DLQ
                                    pipeline.zrem(activeKey, jobId); // Remove from active ZSET
                                    pipeline.zadd(`${this.prefix}:failed:${queueName}`, now, jobId); // Add to failed index ZSET
                                    await pipeline.exec();
                                }
                            } else {
                                // Data is gone from vault, but it's stuck in active ZSET
                                console.log(`🧹 Maintenance: Removing ghost job ${jobId} from active state.`);
                                await this.redisClient.zrem(activeKey, jobId);
                            }
                        }
                    }
                } while (cursor !== '0');
                
            } catch(err) {
                console.error("Zombie watchdog error:", err.message);
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
