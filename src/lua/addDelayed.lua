-- addDelayed.lua
-- Atomic dedup + insert for delayed/repeat jobs.
-- Replaces the racy JS HEXISTS → HSET → signal sequence.
--
-- KEYS[1] = jobs hash      (taurusmq:jobs:queue)
-- KEYS[2] = delayed ZSET   (taurusmq:delayed:queue)
-- KEYS[3] = signal:delayed (taurusmq:signal:delayed:queue)
-- ARGV[1] = jobId
-- ARGV[2] = jobJson
-- ARGV[3] = executetime (ms)
-- ARGV[4] = eventsChannel

local jobId = ARGV[1]
local jobJson = ARGV[2]
local executetime = tonumber(ARGV[3])
local eventsChannel = ARGV[4]

-- Atomic dedup: HEXISTS + HSET + ZADD + LPUSH in one script
if redis.call('HEXISTS', KEYS[1], jobId) == 1 then
    return 0
end

redis.call('HSET', KEYS[1], jobId, jobJson)
redis.call('ZADD', KEYS[2], executetime, jobId)
redis.call('LPUSH', KEYS[3], executetime)

if eventsChannel and eventsChannel ~= '' then
    redis.call('PUBLISH', eventsChannel, '{"event":"delayed","jobId":"' .. jobId .. '"}')
end

return 1
