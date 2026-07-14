-- finalizeJob.lua
-- KEYS[1] = jobs hash         e.g. taurusmq:jobs:myqueue
-- KEYS[2] = active ZSET       e.g. taurusmq:active:myqueue
-- KEYS[3] = completed ZSET    e.g. taurusmq:completed:myqueue
-- KEYS[4] = failed ZSET       e.g. taurusmq:failed:myqueue
-- ARGV[1] = jobId
-- ARGV[2] = status            ('completed' or 'dead')
-- ARGV[3] = returnOrFailedVal (string value for returnvalue or failedReason)
-- ARGV[4] = progressVal       (string progress value or nil)
-- ARGV[5] = nowMs             (timestamp)
-- ARGV[6] = removeOnComplete  (number of completed jobs to retain, 0 for infinite)
-- ARGV[7] = removeOnFail      (number of failed jobs to retain, 0 for infinite)
-- ARGV[8] = prefix            (e.g. 'taurusmq')
-- ARGV[9] = queueName         (e.g. 'myqueue')

local jobId = ARGV[1]
local status = ARGV[2]
local returnOrFailedVal = ARGV[3]
local progressVal = ARGV[4]
local nowMs = tonumber(ARGV[5])
local removeOnComplete = tonumber(ARGV[6] or 0)
local removeOnFail = tonumber(ARGV[7] or 0)
local prefix = ARGV[8]
local queueName = ARGV[9]

-- 1. Fetch current job JSON from jobs hash
local jobJson = redis.call('HGET', KEYS[1], jobId)
if jobJson then
    local job = cjson.decode(jobJson)
    job.status = status
    job.finishedOn = nowMs
    
    if status == 'completed' then
        if returnOrFailedVal and returnOrFailedVal ~= "" then
            local ok, decoded = pcall(cjson.decode, returnOrFailedVal)
            if ok then
                job.returnvalue = decoded
            else
                job.returnvalue = returnOrFailedVal
            end
        else
            job.returnvalue = nil
        end
    else
        job.failedReason = returnOrFailedVal
    end
    
    if progressVal and progressVal ~= "" then
        local num = tonumber(progressVal)
        if num then
            job.progress = num
        else
            local ok, decoded = pcall(cjson.decode, progressVal)
            if ok then
                job.progress = decoded
            else
                job.progress = progressVal
            end
        end
    end
    
    -- Save updated job payload back to jobs hash
    redis.call('HSET', KEYS[1], jobId, cjson.encode(job))
end

-- 2. Remove job from active ZSET
redis.call('ZREM', KEYS[2], jobId)

-- 3. Add to respective state ZSET and perform eviction
if status == 'completed' then
    redis.call('ZADD', KEYS[3], nowMs, jobId)
    
    if removeOnComplete > 0 then
        local total = redis.call('ZCARD', KEYS[3])
        if total > removeOnComplete then
            local toRemove = redis.call('ZRANGE', KEYS[3], 0, total - removeOnComplete - 1)
            for _, id in ipairs(toRemove) do
                redis.call('HDEL', KEYS[1], id)
                redis.call('DEL', prefix .. ':logs:' .. queueName .. ':' .. id)
                redis.call('ZREM', KEYS[3], id)
            end
        end
    end
else
    redis.call('ZADD', KEYS[4], nowMs, jobId)
    
    if removeOnFail > 0 then
        local total = redis.call('ZCARD', KEYS[4])
        if total > removeOnFail then
            local toRemove = redis.call('ZRANGE', KEYS[4], 0, total - removeOnFail - 1)
            for _, id in ipairs(toRemove) do
                redis.call('HDEL', KEYS[1], id)
                redis.call('DEL', prefix .. ':logs:' .. queueName .. ':' .. id)
                redis.call('ZREM', KEYS[4], id)
            end
        end
    end
end

-- 4. Publish completed/failed event to channel
local eventsChannel = prefix .. ':' .. queueName .. ':events'
if status == 'completed' then
    local returnvalue = nil
    if returnOrFailedVal and returnOrFailedVal ~= "" then
        local ok, decoded = pcall(cjson.decode, returnOrFailedVal)
        if ok then
            returnvalue = decoded
        else
            returnvalue = returnOrFailedVal
        end
    end
    local eventPayload = cjson.encode({ event = 'completed', jobId = jobId, returnvalue = returnvalue })
    redis.call('PUBLISH', eventsChannel, eventPayload)
else
    local eventPayload = cjson.encode({ event = 'failed', jobId = jobId, failedReason = returnOrFailedVal })
    redis.call('PUBLISH', eventsChannel, eventPayload)
end

return 1
