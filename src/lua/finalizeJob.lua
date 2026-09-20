-- finalizeJob.lua
-- Finalize one job and, optionally, fetch the next job in the SAME script
-- (fetch-next piggyback: saves the extra dequeue round trip per job in
-- steady state — the worker feeds the returned job straight to the pool).
-- KEYS[1] = jobs hash         e.g. taurusmq:jobs:myqueue
-- KEYS[2] = active ZSET       e.g. taurusmq:active:myqueue
-- KEYS[3] = completed ZSET    e.g. taurusmq:completed:myqueue
-- KEYS[4] = failed ZSET       e.g. taurusmq:failed:myqueue
-- KEYS[5] = waiting list      e.g. taurusmq:myqueue (fetch-next only)
-- KEYS[6] = prioritized ZSET  e.g. taurusmq:prioritized:myqueue (fetch-next only)
-- ARGV[1] = jobId
-- ARGV[2] = status            ('completed' or 'dead')
-- ARGV[3] = returnOrFailedVal (string value for returnvalue or failedReason)
-- ARGV[4] = progressVal       (string progress value or nil)
-- ARGV[5] = nowMs             (timestamp)
-- ARGV[6] = removeOnComplete  (number of completed jobs to retain, 0 for infinite)
-- ARGV[7] = removeOnFail      (number of failed jobs to retain, 0 for infinite)
-- ARGV[8] = prefix            (e.g. 'taurusmq')
-- ARGV[9] = queueName         (e.g. 'myqueue')
-- ARGV[10] = publishEvents    ('1' publish, '0' skip; omitted/nil = publish)
-- ARGV[11] = fetchNext        ('1' = also dequeue next job, else skip)
-- ARGV[12] = leaseExpiration  (timestamp for the fetched job's active lease)
-- Returns {1, nextJobJson-or-false}.

local jobId = ARGV[1]
local status = ARGV[2]
local returnOrFailedVal = ARGV[3]
local progressVal = ARGV[4]
local nowMs = tonumber(ARGV[5])
local removeOnComplete = tonumber(ARGV[6] or 0)
local removeOnFail = tonumber(ARGV[7] or 0)
local prefix = ARGV[8]
local queueName = ARGV[9]
local publishEvents = (ARGV[10] == nil or ARGV[10] ~= '0')
local fetchNext = (ARGV[11] == '1')
local leaseExpiration = tonumber(ARGV[12] or 0)
local nowMs = tonumber(ARGV[5])

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
                -- Eviction guard: skip jobs referenced by DAG (has count or children)
                local hasCount = redis.call('EXISTS', prefix .. ':job:' .. id .. ':count') == 1
                local hasChildren = redis.call('EXISTS', prefix .. ':dependent:' .. id .. ':children:') == 1
                if not hasCount and not hasChildren then
                    redis.call('HDEL', KEYS[1], id)
                    redis.call('DEL', prefix .. ':logs:' .. queueName .. ':' .. id)
                    redis.call('ZREM', KEYS[3], id)
                end
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
                -- Eviction guard: skip jobs referenced by DAG (has count or children)
                local hasCount = redis.call('EXISTS', prefix .. ':job:' .. id .. ':count') == 1
                local hasChildren = redis.call('EXISTS', prefix .. ':dependent:' .. id .. ':children:') == 1
                if not hasCount and not hasChildren then
                    redis.call('HDEL', KEYS[1], id)
                    redis.call('DEL', prefix .. ':logs:' .. queueName .. ':' .. id)
                    redis.call('ZREM', KEYS[4], id)
                    -- DLQ eviction: also remove from DLQ hash
                    redis.call('HDEL', prefix .. ':dlq:' .. queueName, id)
                end
            end
        end
    end
end

-- 4. Publish completed/failed event to channel (skipped for
-- publishEvents=false workers — QueueEvents subscribers are the only
-- consumers, and obs feeds off local hooks instead)
local eventsChannel = prefix .. ':' .. queueName .. ':events'
if publishEvents then
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
end

-- 5. Fetch-next piggyback: dequeue the next job in the same round trip.
-- Identical semantics to dequeue.lua (prioritized first, first-pickup
-- attempts rule, lease, active publish). The worker feeds the returned
-- job straight to the pool; nil/empty queue returns false and the worker
-- falls back to the blocking BLPOP wait.
local nextJson = false
if fetchNext then
    local nextId = nil
    local prioritized_ids = redis.call('ZRANGE', KEYS[6], 0, 0)
    if prioritized_ids and #prioritized_ids > 0 then
        nextId = prioritized_ids[1]
        redis.call('ZREM', KEYS[6], nextId)
    else
        nextId = redis.call('LPOP', KEYS[5])
    end

    if nextId then
        local nextStored = redis.call('HGET', KEYS[1], nextId)
        if nextStored then
            local job = cjson.decode(nextStored)
            -- Only increment attempts on first pickup (same rule as dequeue.lua)
            local isFirstPickup = not job.processedOn or job.processedOn == cjson.null
            if isFirstPickup then
                job.attempts = (job.attempts or 0) + 1
            end
            job.status = 'active'
            job.processedOn = nowMs
            nextJson = cjson.encode(job)
            redis.call('HSET', KEYS[1], nextId, nextJson)
            redis.call('ZADD', KEYS[2], leaseExpiration, nextId)
            if publishEvents then
                local activePayload = cjson.encode({ event = 'active', jobId = nextId, prev = 'waiting' })
                redis.call('PUBLISH', eventsChannel, activePayload)
            end
        end
    end
end

return {1, nextJson}
