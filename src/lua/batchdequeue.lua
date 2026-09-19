-- batchdequeue.lua
-- KEYS[1] = waiting list
-- KEYS[2] = active ZSET
-- KEYS[3] = jobs hash
-- KEYS[4] = prioritized
-- ARGV[1] = batchsize
-- ARGV[2] = leaseExpirationTimestamp

local batchsize = tonumber(ARGV[1])
local leaseExpiration = tonumber(ARGV[2])
local results = {}
local count = 0

-- 1. Dequeue from prioritized first (atomic pop, not ZRANGE+ZREM)
-- (KEYS[4] always passed — numberOfKeys guarantees it)
while count < batchsize do
    local popped = redis.call('ZPOPMIN', KEYS[4])
    if not popped or #popped == 0 then break end
    local jobid = popped[1]
    local jobjson = redis.call('HGET', KEYS[3], jobid)
    if jobjson then
        -- Increment attempts on first pickup (same as single dequeue.lua)
        local job = cjson.decode(jobjson)
        local isFirstPickup = not job.processedOn or job.processedOn == cjson.null
        if isFirstPickup then
            job.attempts = (job.attempts or 0) + 1
        end
        job.status = 'active'
        job.processedOn = tonumber(leaseExpiration)
        local updatedJson = cjson.encode(job)
        redis.call('HSET', KEYS[3], jobid, updatedJson)
        redis.call('ZADD', KEYS[2], leaseExpiration, jobid)
        table.insert(results, updatedJson)
        count = count + 1
    end
    -- If vault missing, job is lost — don't trim, don't add to results
end

-- 2. If we still need more jobs, dequeue from wait list
if count < batchsize then
    local remaining = batchsize - count
    local waiting_ids = redis.call('LRANGE', KEYS[1], 0, remaining - 1)
    if waiting_ids and #waiting_ids > 0 then
        for i, jobid in ipairs(waiting_ids) do
            local jobjson = redis.call('HGET', KEYS[3], jobid)
            if jobjson then
                -- Increment attempts on first pickup (same as single dequeue.lua)
                local job = cjson.decode(jobjson)
                local isFirstPickup = not job.processedOn or job.processedOn == cjson.null
                if isFirstPickup then
                    job.attempts = (job.attempts or 0) + 1
                end
                job.status = 'active'
                job.processedOn = tonumber(leaseExpiration)
                local updatedJson = cjson.encode(job)
                redis.call('HSET', KEYS[3], jobid, updatedJson)
                redis.call('ZADD', KEYS[2], leaseExpiration, jobid)
                table.insert(results, updatedJson)
                -- Remove each processed job individually (safe — no blind LTRIM)
                redis.call('LREM', KEYS[1], 1, jobid)
                count = count + 1
            end
        end
    end
end

return results
