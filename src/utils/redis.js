const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

let defaultClient = null;

function getDefaultClient() {
    if (!defaultClient) {
        defaultClient = new Redis(redisUrl, {
            maxRetriesPerRequest: null,
        });
        defaultClient.on('connect', () => {
            console.log('TaurusMQ: Successfully connected to Redis');
        });
        defaultClient.on('error', (err) => {
            console.error('TaurusMQ: Redis Connection Error:', err.message);
        });
        defineCommands(defaultClient);
    }
    return defaultClient;
}

const redisProxy = new Proxy({}, {
    get(target, prop) {
        if (prop === 'getRedisClient') {
            return getRedisClient;
        }
        const client = getDefaultClient();
        const value = client[prop];
        if (typeof value === 'function') {
            return value.bind(client);
        }
        return value;
    },
    set(target, prop, value) {
        if (prop === 'getRedisClient') {
            target[prop] = value;
            return true;
        }
        getDefaultClient()[prop] = value;
        return true;
    }
});

function defineCommands(client) {
    if (!client.dequeue) {
        client.defineCommand('dequeue', {
            numberOfKeys: 4,
            lua: fs.readFileSync(path.join(__dirname, '../lua/dequeue.lua'), 'utf-8')
        });
    }
    if (!client.promote) {
        client.defineCommand('promote', {
            numberOfKeys: 5,
            lua: fs.readFileSync(path.join(__dirname, '../lua/promote.lua'), 'utf-8')
        });
    }
    if (!client.signal) {
        client.defineCommand('signal', {
            numberOfKeys: 2,
            lua: fs.readFileSync(path.join(__dirname, '../lua/signal.lua'), 'utf-8')
        });
    }
    if (!client.unblock) {
        client.defineCommand('unblock', {
            numberOfKeys: 1,
            lua: fs.readFileSync(path.join(__dirname, '../lua/unblock.lua'), 'utf-8')
        });
    }
    if (!client.batchdequeue) {
        client.defineCommand('batchdequeue', {
            numberOfKeys: 4,
            lua: fs.readFileSync(path.join(__dirname, '../lua/batchdequeue.lua'), 'utf-8')
        });
    }
    if (!client.retry) {
        client.defineCommand('retry', {
            numberOfKeys: 5,
            lua: fs.readFileSync(path.join(__dirname, '../lua/retry.lua'), 'utf-8')
        });
    }
    if (!client.addJob) {
        client.defineCommand('addJob', {
            numberOfKeys: 4,
            lua: fs.readFileSync(path.join(__dirname, '../lua/addJob.lua'), 'utf-8')
        });
    }
    if (!client.recoverStalled) {
        client.defineCommand('recoverStalled', {
            numberOfKeys: 6,
            lua: fs.readFileSync(path.join(__dirname, '../lua/recoverStalled.lua'), 'utf-8')
        });
    }
    if (!client.drain) {
        client.defineCommand('drain', {
            numberOfKeys: 6,
            lua: fs.readFileSync(path.join(__dirname, '../lua/drain.lua'), 'utf-8')
        });
    }
    if (!client.rateLimit) {
        client.defineCommand('rateLimit', {
            numberOfKeys: 1,
            lua: fs.readFileSync(path.join(__dirname, '../lua/rateLimit.lua'), 'utf-8')
        });
    }
    if (!client.finalizeJob) {
        client.defineCommand('finalizeJob', {
            numberOfKeys: 4,
            lua: fs.readFileSync(path.join(__dirname, '../lua/finalizeJob.lua'), 'utf-8')
        });
    }
    return client;
}

function getRedisClient(connectionOptsOrInstance, isBlocking = false) {
    if (connectionOptsOrInstance && typeof connectionOptsOrInstance.duplicate === 'function') {
        if (isBlocking) {
            const dup = connectionOptsOrInstance.duplicate();
            dup.options.maxRetriesPerRequest = null;
            dup.on('error', (err) => {
                console.error('TaurusMQ [Blocking Duplicated Client] Error:', err.message);
            });
            return defineCommands(dup);
        }
        return defineCommands(connectionOptsOrInstance);
    }

    if (typeof connectionOptsOrInstance === 'string') {
        const client = new Redis(connectionOptsOrInstance, { maxRetriesPerRequest: null });
        client.on('error', (err) => {
            console.error('TaurusMQ Client Error:', err.message);
        });
        return defineCommands(client);
    }

    if (connectionOptsOrInstance && typeof connectionOptsOrInstance === 'object') {
        const client = new Redis({ maxRetriesPerRequest: null, ...connectionOptsOrInstance });
        client.on('error', (err) => {
            console.error('TaurusMQ Client Error:', err.message);
        });
        return defineCommands(client);
    }

    // Fallback to default global client
    if (isBlocking) {
        const dup = getDefaultClient().duplicate();
        dup.options.maxRetriesPerRequest = null;
        dup.on('error', (err) => {
            console.error('TaurusMQ [Blocking Default Client] Error:', err.message);
        });
        return defineCommands(dup);
    }
    return redisProxy;
}

module.exports = redisProxy;
module.exports.getRedisClient = getRedisClient;
