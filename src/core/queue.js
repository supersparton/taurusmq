const redis = require("../utils/redis");
const Job = require("./job");
const cron = require('cron-parser');
const { v4: uuid } = require('uuid');

const rediskeyjob = `taurusmq:job:`;
class Queue {
    constructor(queuename, options = {}) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.rediskeyjobs = `taurusmq:jobs:${queuename}`;
        this.rediskeysignal = `taurusmq:signal:${queuename}`;
        this.rediskeyactive = `taurusmq:active:${queuename}`;
        this.rediskeydelayed = `taurusmq:delayed:${queuename}`;
        this.rediskeyblocked = `taurusmq:blocked:${queuename}`;
        this.rediskeydlq = `taurusmq:dlq:${queuename}`;        
        this.schema = options.schema;
    }
    async add(name, data, options = {}) {
        if (this.schema) {
            const result = this.schema.safeParse(data);
            if (!result.success) {
                throw new Error(`Invalid data for job ${name}: ${result.error.message}`);
            }
        }
        const j = new Job(name, data,options);
        await redis.hset(this.rediskeyjobs,j.id,j.toJson);
        if(j.parent && j.parent.length > 0) {
            await redis.hset(this.rediskeyblocked, j.id);
            await redis.set(`taurusmq:job:${j.id}:count`, j.parent.length);
            await redis.set(`taurusmq:job:${j.id}:name`, this.queuename);
            for (let i = 0; i < j.parent.length; i++) {
                await redis.sadd(`taurusmq:dependent:${j.parent[i]}:children:`, j.id);
                await redis.sadd(`taurusmq:dependent:${j.id}:parent:`, j.parent[i]);
            }
            return j.id;
        }
        else if (j.repeat) {
            const interval = cron.CronExpressionParser.parse(j.repeat);
            const executetime = interval.next().getTime();
            j.timestamp = executetime;
            await redis.signal(this.rediskeydelayed, this.rediskeysignal, executetime, j.id);
            return j.id;
        }
        else if (j.delay) {
            const executetime = Date.now() + j.delay;
            j.timestamp = executetime;
            await redis.signal(this.rediskeydelayed, this.rediskeysignal, executetime, j.id);
            console.log(`Job ${j.id} scueduled for ${new Date(executetime).toLocaleTimeString()}`);
        }
        else {
            await redis.rpush(this.rediskey, j.id);
            await redis.lpush(this.rediskeysignal, 1);
        }
        return j.id;
    }
    async addbulk(jobsarray , options = {}){
        const batchid = options.batchid || `batch:${uuid()}`;
        const exists = await redis.exists(`taurusmq:batch:${batchid}:count`);
        if(exists && options.batchid) {
            throw new Error(`Batch ID ${batchid} is already in use!`);
        }
        const pipeline = redis.pipeline();
        pipeline.set(`taurusmq:batch:${batchid}:count`, jobsarray.length);
        for(let i=0;i<jobsarray.length;i++){
            const { name, data, options } = jobsarray[i];
            const j = new Job(name, data, options);
            j.batchid = batchid;
            pipeline.rpush(this.rediskey,j.toJson());
            pipeline.lpush(this.rediskeysignal,1);
        }
        await pipeline.exec();
        console.log("blunk running succesfully on",this.rediskey);
        return batchid;
    }
    async retry(jobid){
        const jobjson = await redis.hget(this.rediskeydlq,jobid);
        if(!jobjson){
            throw new Error ("Job is not found in dead queue");
        }
        const job = JSON.parse(jobjson);
        job.status = "waiting";
        job.attempts = 0;
        await redis.retry(this.rediskeydlq,this.rediskey,this.rediskeysignal,JSON.stringify(job),jobid);
        console.log(`${jobid} is retrying..`);
    }
}

module.exports = Queue;