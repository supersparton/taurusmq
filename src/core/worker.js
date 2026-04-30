const redis = require("../utils/redis");
const Redis = require('ioredis');
const Job = require("./job");
const cron = require('cron-parser');


const rediskeydependent = `taurusmq:dependent:`;
const rediskeyjob =  `taurusmq:job:`;
class Worker {
    constructor(queuename, handler , options = {}) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.rediskeysignal = `taurusmq:signal:${queuename}`;
        this.rediskeydelayed = `taurusmq:delayed:${queuename}`;
        this.rediskeyblocked = `taurusmq:blocked:${queuename}`;
        this.rediskeydlq = `taurusmq:dlq:${queuename}`;
        this.handler = handler;
        this.concurrency = options.concurrency || 1;
        this.running =0;
        this.active = true;
        this.batchsize = options.batchsize || 1;
        this.backoffstrategies = options.backoffstrategies || {};
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
            if(this.batchsize>1){
                let result = null;
                 try {
                    await this.client.blpop(this.rediskeysignal, 60);
                    const result = await redis.batchdequeue(this.rediskey, `taurusmq:active:${this.queuename}`, this.rediskeysignal, this.batchsize);
                
                    if (result && result.length > 0) {
                        const jobs = result.map(JSON.parse);
                        await this.handler(jobs); 
                        for (const job of jobs) {
                            await this.finalizejob(job);
                        }
                    }
                    continue;
                }
                catch(err){
                    console.log( `batch job is failed moving to dlq`);
                    for(let i=0;i<result.length;i++){
                        let job = JSON.parse(result[i]);
                        job.status = "dead";
                        await redis.rpush(`taurusmq:dlq:${this.queuename}`, JSON.stringify(job));
                        await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                    }
                    continue;
                }
            }
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
                    await this.finalizejob(job);
                    job.status = "done";
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
                if(err.name=='Unrecoverable'){
                    job.status = "dead";
                    await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                    this.running--;
                    return await redis.rpush(`taurusmq:dlq:${this.queuename}`, JSON.stringify(job)); 
                }
                job.attempts++;
                if(job.attempts<=job.maxretries) {
                    const delay = this.calculatebackoff(job);
                    const nexttime = Date.now()+delay;
                    console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries}) in ${delay/1000} sec..`);
                    job.status = "retrying";
                    await redis.zadd(this.rediskeydelayed, nexttime,JSON.stringify(job));
                    await redis.signal(this.rediskeydelayed,this.rediskeysignal,nexttime);
                }
                else {
                    console.log(`Job ${job.id} hit max limiting , moving to dlq`);
                    job.status = "dead";
                    await redis.hset(`taurusmq:dlq:${this.queuename}`, job.id, JSON.stringify(job));
                }
                await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                this.running--;
            }
        }
    }
    async finalizejob(job){

        await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
        if(job.flow===true){
            await redis.unblock(job.id, "parent", "children");
        } 
        else if(job.flow===false){
            await redis.unblock(job.id, "children", "parent");
        }
        if (job.batchid) {
            const remaining = await redis.decr(`taurusmq:batch:${job.batchid}:count`);
            if(parseInt(remaining) === 0){
                console.log(`Batch Completed: ${job.batchid}`);
                await redis.del(`taurusmq:batch:${job.batchid}:count`);
            }
        }
    }
    calculatebackoff(job) {
        const backoff = job.backoff || {type : 'fixed', delay : 1000};
        const attempts = job.attempts;
        if(this.backoffstrategies[backoff.type]){
            return this.backoffstrategies[backoff.type]
            (attempts,backoff.delay);
        }
        if(backoff.type == 'fixed'){
            return backoff.delay;
        }
        if(backoff.type=='exponential'){
            return Math.pow(2,attempts-1)*backoff.delay;
        }  
        return 0; 
    }

}

module.exports = Worker;