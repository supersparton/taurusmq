const { getRedisClient } = require("../utils/redis");
const { createLogger } = require("../utils/logger");

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
        // Watchdog sweep interval (also honors legacy positional timeout).
        // Default 50s; tests pass { timeout: 200 } for fast stall recovery.
        this.sweepInterval = time;

        this.connectionOpts = opts.connection;
        this.redisClient = getRedisClient(this.connectionOpts);
        this.client = getRedisClient(this.connectionOpts, true);
        this.logger = createLogger(opts);

        this.watchdogTimer = null;
        this.watchdogResolve = null;
        this.delayedTimer = null;
        this.delayedResolve = null;
    }
    async start() {
        this.logger.info(`watchdog started for queue: ${this.queuename}`);
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
                    now
                );
                if (recoveredCount > 0) {
                    this.logger.info(`Watchdog: Recovered ${recoveredCount} stalled job(s) for queue: ${this.queuename}`);
                }
            }
            catch (err) {
                this.logger.error("Watchdog error : ", err.message);
            }
            if (this.active) {
                await new Promise(resolve => {
                    this.watchdogResolve = resolve;
                    this.watchdogTimer = setTimeout(() => {
                        resolve();
                        this.watchdogResolve = null;
                        this.watchdogTimer = null;
                    }, this.sweepInterval);
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
                     this.logger.info(`${promoted.length} jobs promoted for queue : ${this.queuename}`);
                 }
                const nexttime = await this.redisClient.zrange(this.rediskeydelayed,0,0,'WITHSCORES');
                let waitms = 30000;
                if(nexttime && nexttime.length>0){
                    waitms = parseInt(nexttime[1])-now;
                }
                // Overdue head (or promote race): yield briefly instead of
                // busy-spinning the promote+zrange pair.
                if(waitms<=0){ await new Promise(r => setTimeout(r, 50)); }
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
                this.logger.error("Promotion error : ", err.message);
             }
         }
    }
    async stop() {
        this.active = false;

        // Wake the delayedjobs BLPOP before disconnecting to avoid race
        try {
            await this.redisClient.lpush(this.rediskeysignaldelayed, '__shutdown__');
        } catch (_) {}

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

        // Brief delay to let BLPOP receive the wake token
        await new Promise(r => setTimeout(r, 100));

        if (this.client) {
            try { this.client.disconnect(false); } catch (_) {}
        }

        const redisProxy = require("../utils/redis");
        const connectionIsShared = (this.connectionOpts && typeof this.connectionOpts.duplicate === 'function') || (this.redisClient === redisProxy);
        if (!connectionIsShared && this.redisClient) {
            try { this.redisClient.disconnect(); } catch (_) {}
        }
    }
}

module.exports = Scheduler;