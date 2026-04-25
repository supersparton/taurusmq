const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');

require('dotenv').config();


const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';


const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
});


redis.on('connect', () => {
    console.log('TaurusMQ: Successfully connected to Redis');
});


redis.on('error', (err) => {
    console.error('TaurusMQ: Redis Connection Error:', err.message);
});

redis.defineCommand('dequeue', {
    numberOfKeys: 2,
    lua:
        fs.readFileSync(path.join(__dirname, '../lua/dequeue.lua'), 'utf-8')
});

module.exports = redis;
