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

-- 1. Dequeue from prioritized first
if KEYS[4] then
    local prioritized_ids = redis.call('ZRANGE', KEYS[4], 0, batchsize - 1)
    if prioritized_ids and #prioritized_ids > 0 then
        for i, jobid in ipairs(prioritized_ids) do
            local jobjson = redis.call('HGET', KEYS[3], jobid)
            if jobjson then
                redis.call('ZADD', KEYS[2], leaseExpiration, jobid)
                table.insert(results, jobjson)
            end
            redis.call('ZREM', KEYS[4], jobid)
            count = count + 1
        end
    end
end

-- 2. If we still need more jobs, dequeue from wait list
if count < batchsize then
    local remaining = batchsize - count
    local waiting_ids = redis.call('LRANGE', KEYS[1], 0, remaining - 1)
    if waiting_ids and #waiting_ids > 0 then
        for i, jobid in ipairs(waiting_ids) do
            local jobjson = redis.call('HGET', KEYS[3], jobid)
            if jobjson then
                redis.call('ZADD', KEYS[2], leaseExpiration, jobid)
                table.insert(results, jobjson)
            end
            count = count + 1
        end
        redis.call('LTRIM', KEYS[1], #waiting_ids, -1)
    end
end

return results
