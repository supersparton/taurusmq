-- dequeue.lua
-- KEYS[1] = waiting list   e.g. taurusmq:myqueue
-- KEYS[2] = active ZSET    e.g. taurusmq:active:myqueue
-- KEYS[3] = jobs hash      e.g. taurusmq:jobs:myqueue
-- KEYS[4] = prioritized    e.g. taurusmq:prioritized:myqueue
-- ARGV[1] = nowMs
-- ARGV[2] = lockDuration
-- ARGV[3] = eventsChannel

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
        local job = cjson.decode(jobjson)
        job.attempts = (job.attempts or 0) + 1
        job.status = 'active'
        job.processedOn = tonumber(ARGV[1])
        local updatedJson = cjson.encode(job)
        
        -- Update jobs hash
        redis.call('HSET', KEYS[3], jobid, updatedJson)
        
        -- Add to active ZSET
        local leaseExpiration = tonumber(ARGV[1]) + tonumber(ARGV[2])
        redis.call('ZADD', KEYS[2], leaseExpiration, jobid)
        
        -- Publish active event
        if ARGV[3] and ARGV[3] ~= "" then
            local eventPayload = cjson.encode({ event = 'active', jobId = jobid, prev = 'waiting' })
            redis.call('PUBLISH', ARGV[3], eventPayload)
        end
        
        return updatedJson
    end
end
return nil
