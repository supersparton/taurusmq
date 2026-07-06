-- recoverStalled.lua
-- KEYS[1] = active ZSET         e.g. taurusmq:active:myqueue
-- KEYS[2] = waiting list        e.g. taurusmq:myqueue
-- KEYS[3] = signal list         e.g. taurusmq:signal:myqueue
-- KEYS[4] = prioritized ZSET    e.g. taurusmq:prioritized:myqueue
-- KEYS[5] = jobs hash           e.g. taurusmq:jobs:myqueue
-- KEYS[6] = DLQ hash            e.g. taurusmq:dlq:myqueue
-- ARGV[1] = now
-- ARGV[2] = timeout (unused now, but kept for compatibility)

local now = tonumber(ARGV[1])

local prefix, queueName = string.match(KEYS[1], "^(.+):active:(.+)$")
local channel = prefix .. ":" .. queueName .. ":events"

-- Since the active ZSET stores jobId sorted by their lease expiration timestamp,
-- any job with a score (expiration timestamp) <= now has stalled!
local stalledJobIds = redis.call('ZRANGEBYSCORE', KEYS[1], 0, now)
local movedCount = 0

for _, jobId in ipairs(stalledJobIds) do
    local jobJson = redis.call('HGET', KEYS[5], jobId)
    if jobJson then
        local job = cjson.decode(jobJson)
        local maxretries = tonumber(job.maxretries or 3)
        local attempts = tonumber(job.attempts or 0)
        
        if attempts >= maxretries then
            -- Exceeded max retries, move to DLQ
            job.status = "dead"
            job.failedReason = "job stalled"
            local updatedJson = cjson.encode(job)
            redis.call('HSET', KEYS[5], jobId, updatedJson)
            redis.call('HSET', KEYS[6], jobId, updatedJson)
            -- Also add to failed ZSET index!
            redis.call('ZADD', prefix .. ':failed:' .. queueName, now, jobId)
            
            -- Publish failed event
            redis.call('PUBLISH', channel, '{"event":"failed","jobId":"' .. jobId .. '","failedReason":"job stalled"}')
        else
            -- Recover to waiting / prioritized
            job.status = "waiting"
            local updatedJson = cjson.encode(job)
            redis.call('HSET', KEYS[5], jobId, updatedJson)
            
            local hasPriority = false
            local priorityVal = 0
            if job.priority then
                local p = tonumber(job.priority)
                if p and p > 0 then
                    hasPriority = true
                    priorityVal = p
                end
            end
            
            if hasPriority then
                local score = priorityVal * 100000000000 + (tonumber(job.timestamp or 0) - 1700000000000)
                redis.call('ZADD', KEYS[4], score, jobId)
            else
                redis.call('RPUSH', KEYS[2], jobId)
            end
            redis.call('LPUSH', KEYS[3], 1)
            
            -- Publish stalled event
            redis.call('PUBLISH', channel, '{"event":"stalled","jobId":"' .. jobId .. '"}')
        end
    end
    -- Remove from active ZSET
    redis.call('ZREM', KEYS[1], jobId)
    movedCount = movedCount + 1
end

return movedCount
