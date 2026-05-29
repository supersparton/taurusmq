const redis = require("../utils/redis");
const Redis = require('ioredis');

class Maintenance {
    constructor(options = {}) {
        this.client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });
        this.active = true;
        this.zombieTimeout = options.zombieTimeout || 24 * 60 * 60 * 1000; // default 24 hours
        this.checkInterval = options.checkInterval || 60 * 1000; // default 1 minute
    }

    async start() {
        console.log(`🧹 TaurusMQ Maintenance Engine started.`);
        
        // Run background workers without blocking
        this.runMaintenanceLoop();
        this.runZombieWatchdog();
    }

    async stop() {
        this.active = false;
        this.client.disconnect();
    }

    // 1. Cascading Deletions (From the _internal queue)
    async runMaintenanceLoop() {
        while (this.active) {
            try {
                // Wait for a task, timeout every 5s so we can check if still active
                const result = await this.client.blpop('taurusmq:_internal:maintenance', 5);
                if (result) {
                    const task = JSON.parse(result[1]);
                    
                    if (task.type === 'delete') {
                        await this.handleDeletion(task.jobId, task.queue);
                    }
                }
            } catch (err) {
                console.error("Maintenance loop error:", err.message);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }

    async handleDeletion(startJobId, queueName) {
        const idsToDelete = [];
        const queue = [startJobId];

        // Iterative BFS to find all children without Call Stack Overflow
        while (queue.length > 0) {
            const currentId = queue.shift();
            idsToDelete.push(currentId);

            const children = await redis.smembers(`taurusmq:dependent:${currentId}:children:`);
            if (children && children.length > 0) {
                queue.push(...children);
            }
        }

        // Delete all found jobs atomically using a Pipeline
        const pipeline = redis.pipeline();
        
        for (const id of idsToDelete) {
            // A. Clean up Dependencies & Tracking
            pipeline.del(`taurusmq:dependent:${id}:children:`);
            pipeline.del(`taurusmq:dependent:${id}:parent:`);
            pipeline.del(`taurusmq:job:${id}:count`);
            pipeline.del(`taurusmq:job:${id}:name`);
            
            // B. Remove from ALL queue states
            pipeline.lrem(`taurusmq:${queueName}`, 0, id); 
            pipeline.zrem(`taurusmq:delayed:${queueName}`, id);
            pipeline.hdel(`taurusmq:active:${queueName}`, id);
            pipeline.hdel(`taurusmq:dlq:${queueName}`, id);
            pipeline.hdel(`taurusmq:blocked:${queueName}`, id);
            
            // C. Remove the actual payload from the Job Vault
            pipeline.hdel(`taurusmq:jobs:${queueName}`, id);
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
                    const [newCursor, keys] = await redis.scan(cursor, 'MATCH', 'taurusmq:active:*', 'COUNT', 100);
                    cursor = newCursor;

                    for (const activeKey of keys) {
                        const queueName = activeKey.split(':')[2];
                        const activeJobs = await redis.hgetall(activeKey);
                        
                        const now = Date.now();
                        for (const [jobId, _] of Object.entries(activeJobs)) {
                            const jobJson = await redis.hget(`taurusmq:jobs:${queueName}`, jobId);
                            
                            if (jobJson) {
                                const job = JSON.parse(jobJson);
                                
                                // If the job has been active for more than zombieTimeout
                                if (now - job.timestamp > this.zombieTimeout) {
                                    console.log(`🧟 Zombie detected! Job ${jobId} in ${queueName} exceeded timeout. Moving to DLQ.`);
                                    job.status = 'dead';
                                    job.error = 'Zombie timeout exceeded. Worker probably crashed.';
                                    
                                    const pipeline = redis.pipeline();
                                    pipeline.hset(`taurusmq:jobs:${queueName}`, jobId, JSON.stringify(job)); // Update vault
                                    pipeline.hset(`taurusmq:dlq:${queueName}`, jobId, JSON.stringify(job)); // Store in DLQ
                                    pipeline.hdel(activeKey, jobId); // Remove from active
                                    await pipeline.exec();
                                }
                            } else {
                                // Data is gone from vault, but it's stuck in active hash
                                console.log(`🧹 Maintenance: Removing ghost job ${jobId} from active state.`);
                                await redis.hdel(activeKey, jobId);
                            }
                        }
                    }
                } while (cursor !== '0');
                
            } catch(err) {
                console.error("Zombie watchdog error:", err.message);
            }
            
            // Sleep for the interval before checking again
            await new Promise(r => setTimeout(r, this.checkInterval));
        }
    }
}

module.exports = Maintenance;
