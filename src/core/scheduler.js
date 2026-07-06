const { getRedisClient } = require("../utils/redis");

class Scheduler {
    constructor(queuename, timeOrOptions, options = {}) {
        let time = 50000;
        let opts = {};
        if (typeof timeOrOptions === 'object' && timeOrOptions !== null) {
            opts = timeOrOptions;
            time = opts.timeout || 50000;
        } else {
            time = timeOrOptions || 50000;
            opts = options || {};
        }
        this.queuename = queuename;
        this.prefix = opts.prefix || 'taurusmq';
        this.rediskeywaiting = `${this.prefix}:${queuename}`;
        this.rediskeyactive = `${this.prefix}:active:${queuename}`;
        this.rediskeyprioritized = `${this.prefix}:prioritized:${queuename}`;
        this.rediskeydelayed = `${this.prefix}:delayed:${queuename}`;
        this.rediskeysignal = `${this.prefix}:signal:${queuename}`;
        this.rediskeysignaldelayed = `${this.prefix}:signal:delayed:${queuename}`;
        this.rediskeyblocked = `${this.prefix}:blocked:${queuename}`;
        this.active = true;
        this.timeout = time;
        
        this.connectionOpts = opts.connection;
        this.redisClient = getRedisClient(this.connectionOpts);
        this.client = getRedisClient(this.connectionOpts, true);

        this.watchdogTimer = null;
        this.watchdogResolve = null;
        this.delayedTimer = null;
        this.delayedResolve = null;
    }
    async start() {
        console.log(`watchdog started for queue: ${this.queuename}`);
        while (this.active) {
            try {
                const now = Date.now();
                const recoveredCount = await this.redisClient.recoverStalled(
                    this.rediskeyactive,
                    this.rediskeywaiting,
                    this.rediskeysignal,
                    this.rediskeyprioritized,
                    `${this.prefix}:jobs:${this.queuename}`,
                    `${this.prefix}:dlq:${this.queuename}`,
                    now,
                    this.timeout
                );
                if (recoveredCount > 0) {
                    console.log(`Watchdog: Recovered ${recoveredCount} stalled job(s) for queue: ${this.queuename}`);
                }
            }
            catch (err) {
                console.log("Watchdog error : ", err.message);
            }
            if (this.active) {
                await new Promise(resolve => {
                    this.watchdogResolve = resolve;
                    this.watchdogTimer = setTimeout(() => {
                        resolve();
                        this.watchdogResolve = null;
                        this.watchdogTimer = null;
                    }, 60000);
                });
            }
        }
    }
    async delayedjobs(){
         while(this.active){
             try{
                const now = Date.now();
                 const promoted = await this.redisClient.promote(
                     this.rediskeydelayed,
                     this.rediskeywaiting,
                     this.rediskeysignal,
                     this.rediskeyprioritized,
                     `${this.prefix}:jobs:${this.queuename}`,
                     now
                 );
                 if (promoted && promoted.length > 0) {
                     console.log(`${promoted.length} jobs promoted for queue : ${this.queuename}`);
                 }
                const nexttime = await this.redisClient.zrange(this.rediskeydelayed,0,0,'WITHSCORES');
                let waitms = 30000;
                if(nexttime && nexttime.length>0){
                    waitms = parseInt(nexttime[1])-now;
                }
                if(waitms<=0){}
                else if(waitms<=1000){
                    if (this.active) {
                        await new Promise(resolve => {
                            this.delayedResolve = resolve;
                            this.delayedTimer = setTimeout(() => {
                                resolve();
                                this.delayedResolve = null;
                                this.delayedTimer = null;
                            }, waitms);
                        });
                    }
                }
                else{
                    await this.client.blpop(this.rediskeysignaldelayed, Math.floor(waitms/1000));
                }
             }
             catch(err){
                console.log("Promotion error : ", err.message);
             }
         }
    }
    async stop() {
        this.active = false;
        if (this.client) {
            this.client.disconnect(false);
        }
        if (this.watchdogTimer) {
            clearTimeout(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.watchdogResolve) {
            this.watchdogResolve();
            this.watchdogResolve = null;
        }
        if (this.delayedTimer) {
            clearTimeout(this.delayedTimer);
            this.delayedTimer = null;
        }
        if (this.delayedResolve) {
            this.delayedResolve();
            this.delayedResolve = null;
        }

        const redisProxy = require("../utils/redis");
        const connectionIsShared = (this.connectionOpts && typeof this.connectionOpts.duplicate === 'function') || (this.redisClient === redisProxy);
        if (!connectionIsShared && this.redisClient) {
            try { this.redisClient.disconnect(); } catch (_) {}
        }
    }
}

module.exports = Scheduler;