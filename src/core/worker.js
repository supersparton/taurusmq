const redis = require("../utils/redis");
const Redis = require('ioredis');
const Job = require("./job");
const cron =require('cron-parser');

class Worker {
    constructor(queuename, handler , options = {}) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.rediskeysignal = `taurusmq:signal:${queuename}`;
        this.rediskeydelayed = `taurusmq:delayed:${queuename}`;
        
        this.handler = handler;
        this.concurrency = options.concurrency || 1;
        this.running =0;
        this.active = true;
        this.client = new Redis(process.env.REDIS_URL, {
            maxRetriesPerRequest: null,
        });
    }
    async start() {
        console.log(`Woker started for queue ${this.queuename} with concurrency ${this.concurrency}`);
        for(let i=0;i<this.concurrency;i++){
            this.work(i+1);
        }
    }
    async work(id){
        while(this.active){
            let job = null;
            try {
                await this.client.blpop(this.rediskeysignal, 60);
                const jobjson = await redis.dequeue(
                    this.rediskey,
                    `taurusmq:active:${this.queuename}`,
                    Date.now()
                );
                if (jobjson) {
                    this.running++;
                    job = JSON.parse(jobjson);
                    await this.handler(job);
                    await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                    this.running--;
                    if(job.repeat){
                        try{
                            const interval = cron.CronExpressionParser.parse(job.repeat,{
                                currentDate : new Date(job.timestamp)
                            });
                            const executetime = interval.next().getTime();
                            const newjob = new Job(job.name,job.data);
                            newjob.repeat = job.repeat;
                            newjob.timestamp = executetime;
                            await redis.signal(this.rediskeydelayed,this.rediskeysignal, executetime, newjob.toJson());
                            console.log(`Scheduled next run for ${new Date(executetime).toLocaleTimeString()} in taurusmq:${this.queuename} of Job ${job.id}`);
                        }
                        catch(err){
                            console.error("Cron rescheduling failed :", err.message, `for taurusmq:${this.queuename} of Job ${job.id}`);
                        }
                    }
                }
            }
            catch (err) {
                console.log(`job ${job.id} failed : `, err.message);
                job.attempts++;
                if (job.attempts <= job.maxretries) {
                    console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries})`);
                    await redis.rpush(this.rediskey, JSON.stringify(job));
                }
                else {
                    console.log(`Job ${job.id} hit max limiting , moving to dlq`);
                    await redis.rpush(`taurusmq:dlq:${this.queuename}`, JSON.stringify(job));
                }
                await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                this.running--;
            }
        }
    }
}

module.exports = Worker;