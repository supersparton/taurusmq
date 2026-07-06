// src/core/queue-events.js
'use strict';

const EventEmitter = require('events');
const { getRedisClient } = require('../utils/redis');

class QueueEvents extends EventEmitter {
    constructor(queuename, options = {}) {
        super();
        this.queuename = queuename;
        this.prefix = options.prefix || 'taurusmq';
        this.connectionOpts = options.connection;
        this.channel = `${this.prefix}:${this.queuename}:events`;

        this.client = getRedisClient(this.connectionOpts, true);
        
        this.client.subscribe(this.channel).catch((err) => {
            this.emit('error', err);
        });

        this.client.on('message', (channel, message) => {
            if (channel === this.channel) {
                try {
                    const data = JSON.parse(message);
                    if (data.event) {
                        this.emit(data.event, data);
                    }
                } catch (_) {
                    // Ignore malformed messages
                }
            }
        });

        this.client.on('error', (err) => {
            this.emit('error', err);
        });
    }

    async close() {
        try {
            await this.client.unsubscribe(this.channel);
        } catch (_) {}
        try {
            this.client.disconnect(false);
        } catch (_) {}
    }
}

module.exports = QueueEvents;
