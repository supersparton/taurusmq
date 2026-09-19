-- retry.lua
-- KEYS[1] = DLQ hash
-- KEYS[2] = waiting list
-- KEYS[3] = signal list
-- KEYS[4] = jobs hash
-- KEYS[5] = prioritized ZSET
-- KEYS[6] = failed ZSET (for cleanup)
-- ARGV[1] = jobjson
-- ARGV[2] = jobid

-- Score constants (freeze — changing invalidates existing scores)
local PRIORITY_SCALE = 100000000000   -- 1e11
local EPOCH_BASE = 1700000000000      -- 2023-11-14T22:13:20Z

local function calcScore(priority, timestamp)
    return priority * PRIORITY_SCALE + (timestamp - EPOCH_BASE)
end

local jobjson = ARGV[1]
local jobid = ARGV[2]

if(jobid) then
    -- Remove from DLQ
    redis.call('HDEL',KEYS[1],jobid)
    -- Remove from failed ZSET (fixes getJobCounts lying after retry)
    redis.call('ZREM',KEYS[6],jobid)
    -- Update vault
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
        local score = calcScore(priorityVal, timestampVal)
        redis.call('ZADD', KEYS[5], score, jobid)
    else
        -- Dedup guard: remove from waiting list before re-enqueue (idempotent retry)
        redis.call('LREM', KEYS[2], 0, jobid)
        redis.call('RPUSH', KEYS[2], jobid)
    end
    
    redis.call('LPUSH', KEYS[3], 1)
end

return nil
