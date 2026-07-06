-- promote.lua
-- KEYS[1] = delayed ZSET     e.g. taurusmq:delayed:myqueue
-- KEYS[2] = waiting list     e.g. taurusmq:myqueue
-- KEYS[3] = signal list      e.g. taurusmq:signal:myqueue
-- KEYS[4] = prioritized ZSET e.g. taurusmq:prioritized:myqueue
-- KEYS[5] = jobs hash        e.g. taurusmq:jobs:myqueue
-- ARGV[1] = now

local jobs = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1]);

local prefix, queueName = string.match(KEYS[1], "^(.+):delayed:(.+)$")
local channel = prefix .. ":" .. queueName .. ":events"

if #jobs > 0 then
    for i, job in ipairs(jobs) do
        -- Check if job has priority
        local jobJson = redis.call('HGET', KEYS[5], job)
        local hasPriority = false
        local priorityVal = 0
        local timestampVal = 0
        if jobJson then
            local jobObj = cjson.decode(jobJson)
            if jobObj.priority then
                local p = tonumber(jobObj.priority)
                if p and p > 0 then
                    hasPriority = true
                    priorityVal = p
                    timestampVal = tonumber(jobObj.timestamp or 0)
                end
            end
        end

        if hasPriority then
            local score = priorityVal * 100000000000 + (timestampVal - 1700000000000)
            redis.call('ZADD', KEYS[4], score, job)
        else
            redis.call('RPUSH', KEYS[2], job)
        end

        redis.call('ZREM', KEYS[1], job)
        redis.call('LPUSH', KEYS[3], 1)
        
        -- Publish waiting event
        redis.call('PUBLISH', channel, '{"event":"waiting","jobId":"' .. job .. '"}')
    end
    return jobs
end

-- Return empty array
return {}