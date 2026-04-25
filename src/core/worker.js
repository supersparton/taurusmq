const redis = require("../utils/redis");

class Worker {
    constructor(queuename, handler) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.handler = handler;
        this.active = true;
    }
    async start() {
        console.log(`Woker started for queue ${this.queuename}`);
        while (this.active) {
            try {
                const jobjson = await redis.dequeue(
                    2,
                    this.rediskey,
                    `taurusmq:active:${this.queuename}`,
                    Date.now()
                );
                if (jobjson) {
                    const job = JSON.parse(jobjson);
                    await this.handler(job);
                    await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                }
                else {
                    await new Promise(resolve => {
                        setTimeout(resolve, 1000);
                    });
                }
            }
            catch (err) {
                console.log(`job ${job.id} failed : `, err.message);
                job.attempts++;
                if (job.attempts < job.maxretries) {
                    console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries})`);
                    await redis.rpush(this.rediskey, JSON.stringify(job));
                }
                else {
                    console.log(`Job ${job.id} hit max limiting , moving to dlq`);
                    await redis.rpush(`taurusmq:dlq${this.queuename}`, JSON.stringify(job));
                }
                await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
            }
        }
    }
}

module.exports = Worker;