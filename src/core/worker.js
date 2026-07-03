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
        this.rediskeysignaldelayed = `taurusmq:signal:delayed:${queuename}`;
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
            try {
                const isPaused = await this.client.get(`taurusmq:paused:${this.queuename}`) === '1';
                if (isPaused) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            } catch (_) {}

            let job = null;
            if(this.batchsize>1){
                let batchResult = null;
                 try {
                    await this.client.blpop(this.rediskeysignal, 60);
                    batchResult = await redis.batchdequeue(this.rediskey, `taurusmq:active:${this.queuename}`, `taurusmq:jobs:${this.queuename}`, this.batchsize);
                
                    if (batchResult && batchResult.length > 0) {
                        const jobs = batchResult.map(JSON.parse);
                        for (const j of jobs) {
                            j.attempts = (j.attempts || 0) + 1;
                            await this.scheduleNextRun(j);
                        }
                        try {
                            await this.handler(jobs); 
                            for (const j of jobs) {
                                await this.finalizejob(j);
                            }
                        } catch(err) {
                            console.log(`batch job has failed moving to dlq`);
                            for(const j of jobs) {
                                j.status = "dead";
                                await this.client.hset(`taurusmq:jobs:${this.queuename}`, j.id, JSON.stringify(j));
                                await redis.hset(`taurusmq:dlq:${this.queuename}`, j.id, JSON.stringify(j));
                                await redis.hdel(`taurusmq:active:${this.queuename}`, j.id);
                            }
                        }
                    }
                    continue;
                }
                catch(err){
                    console.log(`batch job error:`, err.message);
                    continue;
                }
            }
            try {
                await this.client.blpop(this.rediskeysignal, 60);
                const jobjson = await redis.dequeue(
                    this.rediskey,
                    `taurusmq:active:${this.queuename}`,
                    `taurusmq:jobs:${this.queuename}`
                );
                if (jobjson) {
                    this.running++;
                    job = JSON.parse(jobjson);
                    job.attempts++;
                    await this.scheduleNextRun(job);
                    await this.handler(job);
                    await this.finalizejob(job);
                    job.status = "done";
                    this.running--;
                }
            }
            catch (err) {
                console.log(`job ${job.id} failed : `, err.message);
                if(err.name=='Unrecoverable'){
                    job.status = "dead";
                    await this.client.hset(`taurusmq:jobs:${this.queuename}`, job.id, JSON.stringify(job));
                    await redis.hset(`taurusmq:dlq:${this.queuename}`, job.id, JSON.stringify(job));
                    await redis.hdel(`taurusmq:active:${this.queuename}`, job.id);
                    this.running--;
                    continue; 
                }
                if(job.attempts < job.maxretries) {
                    const delay = this.calculatebackoff(job);
                    const nexttime = Date.now()+delay;
                    console.log(`retrying job ${job.id} (attempt ${job.attempts}/${job.maxretries}) in ${delay/1000} sec..`);
                    job.status = "retrying";
                    await this.client.hset(`taurusmq:jobs:${this.queuename}`, job.id, JSON.stringify(job));
                    await redis.signal(this.rediskeydelayed, this.rediskeysignaldelayed, nexttime, job.id);
                }
                else {
                    console.log(`Job ${job.id} hit max limiting , moving to dlq`);
                    job.status = "dead";
                    await this.client.hset(`taurusmq:jobs:${this.queuename}`, job.id, JSON.stringify(job));
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
    async scheduleNextRun(job) {
        if (!job.repeat) return;
        try {
            const interval = cron.CronExpressionParser.parse(job.repeat, {
                currentDate: new Date(job.timestamp)
            });
            const executetime = interval.next().getTime();
            const newjob = new Job(job.name, job.data);
            newjob.repeat = job.repeat;
            newjob.timestamp = executetime;
            newjob.status = 'delayed';

            await this.client.hset(`taurusmq:jobs:${this.queuename}`, newjob.id, newjob.toJson());
            await redis.signal(this.rediskeydelayed, this.rediskeysignaldelayed, executetime, newjob.id);
            console.log(`Scheduled next run for ${new Date(executetime).toLocaleTimeString()} in taurusmq:${this.queuename} of Job ${newjob.id}`);
        } catch(err) {
            console.error("Cron rescheduling failed:", err.message, `for taurusmq:${this.queuename} of Job ${job.id}`);
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