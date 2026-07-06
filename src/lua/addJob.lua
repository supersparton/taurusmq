-- addJob.lua
-- KEYS[1] = jobs hash      e.g. taurusmq:jobs:myqueue
-- KEYS[2] = waiting list   e.g. taurusmq:myqueue
-- KEYS[3] = signal list    e.g. taurusmq:signal:myqueue
-- KEYS[4] = prioritized    e.g. taurusmq:prioritized:myqueue
-- ARGV[1] = jobId
-- ARGV[2] = jobJson
-- ARGV[3] = priority (0 if none)
-- ARGV[4] = timestamp (milliseconds)

local jobId   = ARGV[1]
local jobJson = ARGV[2]
local priority = tonumber(ARGV[3] or 0)
local timestamp = tonumber(ARGV[4] or 0)

-- Deduplication: if this id already exists, do nothing and return 0
if redis.call('HEXISTS', KEYS[1], jobId) == 1 then
    return 0
end

redis.call('HSET',  KEYS[1], jobId, jobJson)
if priority > 0 then
    local score = priority * 100000000000 + (timestamp - 1700000000000)
    redis.call('ZADD', KEYS[4], score, jobId)
else
    redis.call('RPUSH', KEYS[2], jobId)
end
redis.call('LPUSH', KEYS[3], 1)
return 1
