const redis = require("../utils/redis");
const Job = require("./job");
const cron =require('cron-parser');

class Queue {
    constructor(queuename, options = {}) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.rediskeysignal = `taurusmq:signal:${queuename}`;
        this.rediskeydelayed = `taurusmq:delayed:${queuename}`;
        this.schema = options.schema;
    }
    async add(name, data, options = {}) {
        if (this.schema) {
            const result = this.schema.safeParse(data);
            if (!result.success) {
                throw new Error(`Invalid data for job ${name}: ${result.error.message}`);
            }
        }
        const j = new Job(name, data);
        if(options.repeat){
            j.repeat = options.repeat; 
            const interval = cron.CronExpressionParser.parse(options.repeat);
            const executetime = interval.next().getTime();
            j.timestamp = executetime;
            await redis.signal(this.rediskeydelayed, this.rediskeysignal, executetime, j.toJson());
            return j.id;
        }
        if(options.delay){
            const executetime = Date.now() + options.delay;
            j.timestamp = executetime;
            await redis.signal(this.rediskeydelayed,this.rediskeysignal, executetime, j.toJson());
            console.log(`Job ${j.id} scueduled for ${new Date(executetime).toLocaleTimeString()}`);
        }
        else{
            await redis.rpush(this.rediskey, j.toJson());
            await redis.lpush(this.rediskeysignal, 1);
        }
        return j.id;
    }
}

module.exports = Queue;