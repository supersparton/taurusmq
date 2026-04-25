const redis = require("../utils/redis");

class Scheduler {
    constructor(queuename, time) {
        this.queuename = queuename;
        this.rediskeywaiting = `taurusmq:${queuename}`;
        this.rediskeyactive = `taurusmq:active:${queuename}`;
        this.active = true;
        this.timeout = time || 50000;
    }
    async start() {
        console.log(`watchdog started for queue: ${this.queuename}`);
        while (this.active) {
            try {
                const activejob = await redis.hgetall(this.rediskeyactive);
                for (const jobid in activejobjob) {
                    const job = JSON.parse(activejob[jobid]);
                    if (Date.now() - job.timestamp > timeout) {
                        console.log(`recovering job : ${jobid}`);
                        await redis.rpush(this.rediskeywaiting, JSON.stringify(job));
                        await redis.hdel(this.rediskeyactive, jobid);
                    }
                }
            }
            catch (err) {
                console.log("Watchdog error : ", err.message);
            }
            await new Promise(resolve =>
                setTimeout(resolve, 60000)
            );
        }
    }
}

module.exports = Scheduler