const Redis = require("ioredis");
const redis = require("../utils/redis");


const rediskeydependent = `taurusmq:dependent:`;
const rediskeyjob =  `taurusmq:job:`;
class Scheduler {
    constructor(queuename, time) {
        this.queuename = queuename;
        this.rediskeywaiting = `taurusmq:${queuename}`;
        this.rediskeyactive = `taurusmq:active:${queuename}`;
        this.rediskeydelayed = `taurusmq:delayed:${queuename}`;
        this.rediskeysignal = `taurusmq:signal:${queuename}`;
        this.rediskeyblocked = `taurusmq:blocked:${queuename}`;
        this.active = true;
        this.timeout = time || 50000;
        this.client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });
    }
    async start() {
        console.log(`watchdog started for queue: ${this.queuename}`);
        while (this.active) {
            try {
                const activejob = await redis.hgetall(this.rediskeyactive);
                for (const jobid in activejob) {
                    const job = JSON.parse(activejob[jobid]);
                    if (Date.now() - job.timestamp > this.timeout) {
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
    async delayedjobs(){
         while(this.active){
             try{
                const now = Date.now();
                const count = await redis.promote(this.rediskeydelayed,this.rediskeywaiting,this.rediskeysignal,now);
                if(count>0) console.log(`${count} jobs for queue : ${this.queuename}`);
                const nexttime = await redis.zrange(this.rediskeydelayed,0,0,'WITHSCORES');
                let waitms = 30000;
                if(nexttime && nexttime.length>0){
                    waitms = parseInt(nexttime[1])-now;
                }
                if(waitms<=0){}
                else if(waitms<=1000){
                    await new Promise(resolve=>setTimeout(resolve,waitms));
                }
                else{
                    await this.client.blpop(this.rediskeysignal, Math.floor(waitms/1000));
                }
             }
             catch(err){
                console.log("Promotion error : ", err.message);
             }
         }
    }
}

module.exports = Scheduler