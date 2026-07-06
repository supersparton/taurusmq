-- dequeue.lua
-- KEYS[1] = waiting list   e.g. taurusmq:myqueue
-- KEYS[2] = active ZSET    e.g. taurusmq:active:myqueue
-- KEYS[3] = jobs hash      e.g. taurusmq:jobs:myqueue
-- KEYS[4] = prioritized    e.g. taurusmq:prioritized:myqueue
-- ARGV[1] = leaseExpirationTimestamp

-- 1. Check prioritized ZSET first
local jobid = nil
local prioritized_ids = redis.call('ZRANGE', KEYS[4], 0, 0)
if prioritized_ids and #prioritized_ids > 0 then
    jobid = prioritized_ids[1]
    redis.call('ZREM', KEYS[4], jobid)
else
    -- 2. Fall back to waiting list
    jobid = redis.call('LPOP', KEYS[1])
end

if jobid then
    local jobjson = redis.call('HGET', KEYS[3], jobid)
    if jobjson then
        redis.call('ZADD', KEYS[2], tonumber(ARGV[1]), jobid)
        return jobjson
    end
end
return nil
