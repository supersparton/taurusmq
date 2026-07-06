-- rateLimit.lua
-- KEYS[1] = limiter ZSET   e.g. taurusmq:limiter:myqueue
-- ARGV[1] = now (timestamp in ms)
-- ARGV[2] = duration (ms)
-- ARGV[3] = max (tokens)

local key = KEYS[1]
local now = tonumber(ARGV[1])
local duration = tonumber(ARGV[2])
local max = tonumber(ARGV[3])

local clearBefore = now - duration
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)

local count = redis.call('ZCARD', key)

if count < max then
    redis.call('ZADD', key, now, now)
    redis.call('PEXPIRE', key, duration)
    return {1, 0}
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local waitTime = 0
    if oldest and oldest[2] then
        local oldestScore = tonumber(oldest[2])
        waitTime = (oldestScore + duration) - now
    else
        waitTime = duration
    end
    if waitTime < 0 then
        waitTime = 0
    end
    return {0, waitTime}
end
