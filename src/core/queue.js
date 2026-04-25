const redis = require("../utils/redis");
const Job = require("./job");

class Queue {
    constructor(queuename, options = {}) {
        this.queuename = queuename;
        this.rediskey = `taurusmq:${queuename}`;
        this.schema = options.schema;
    }
    async add(name, data) {
        if (this.schema) {
            const result = this.schema.safeParse(data);
            if (!result.success) {
                throw new Error(`Invalid data for job ${name}: ${result.error.message}`);
            }
        }
        const j = new Job(name, data);
        await redis.rpush(this.rediskey, j.toJson());
        return j.id;
    }
}

module.exports = Queue;