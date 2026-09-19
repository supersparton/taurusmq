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
        this._malformedCount = 0;
        this._reconnectAttempts = 0;
        this._maxReconnectAttempts = options.maxReconnectAttempts || 10;
        this._reconnectDelay = options.reconnectDelay || 1000;

        this.client = getRedisClient(this.connectionOpts, true);
        
        this._subscribe();
        this._attachHandlers(this.client);
    }

    _attachHandlers(client) {
        client.on('message', (channel, message) => {
            if (channel === this.channel) {
                try {
                    const data = JSON.parse(message);
                    if (data.event) {
                        this.emit(data.event, data);
                    }
                } catch (_) {
                    this._malformedCount++;
                }
            }
        });
        client.on('error', (err) => {
            this.emit('error', err);
            this._reconnect();
        });
        client.on('end', () => {
            this._reconnect();
        });
    }

    _subscribe() {
        // Closed on purpose (close() disconnects) — never retry.
        if (!this.client || this.client.status === 'end') return;
        // ioredis auto-reconnects the SAME client and re-issues SUBSCRIBE —
        // just re-assert the subscription. (Rotating clients here leaked the
        // old subscribed connection and stacked duplicate handlers.)
        // subscribe() can throw synchronously on a dead connection, so guard.
        let pending;
        try {
            pending = this.client.subscribe(this.channel);
        } catch (err) {
            this.emit('error', err);
            this._reconnect();
            return;
        }
        pending.then(
            () => { this._reconnectAttempts = 0; },
            (err) => { this.emit('error', err); this._reconnect(); }
        );
    }

    _reconnect() {
        if (this._reconnectAttempts >= this._maxReconnectAttempts) {
            this.emit('error', new Error(`QueueEvents: max reconnect attempts (${this._maxReconnectAttempts}) reached for ${this.channel}`));
            return;
        }
        this._reconnectAttempts++;
        const delay = this._reconnectDelay * Math.min(this._reconnectAttempts, 5);
        setTimeout(() => this._subscribe(), delay);
    }

    get malformedCount() {
        return this._malformedCount;
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
