-- retry.lua
-- KEYS[1] = DLQ hash
-- KEYS[2] = waiting list
-- KEYS[3] = signal list
-- KEYS[4] = jobs hash
-- KEYS[5] = prioritized ZSET
-- ARGV[1] = jobjson
-- ARGV[2] = jobid

local jobjson = ARGV[1]
local jobid = ARGV[2]

if(jobid) then
    redis.call('HDEL',KEYS[1],jobid)
    redis.call('HSET',KEYS[4],jobid,jobjson)
    
    local hasPriority = false
    local priorityVal = 0
    local timestampVal = 0
    if jobjson then
        local jobObj = cjson.decode(jobjson)
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
        redis.call('ZADD', KEYS[5], score, jobid)
    else
        redis.call('RPUSH', KEYS[2], jobid)
    end
    
    redis.call('LPUSH', KEYS[3], 1)
end

return nil