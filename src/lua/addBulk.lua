-- addBulk.lua
-- Atomic bulk insert with per-item dedup.
-- Each item is deduped independently via HEXISTS; existing items return 0,
-- new items return 1. Everything runs in a single round-trip.
--
-- KEYS[1] = jobs hash      (taurusmq:jobs:queue)
-- KEYS[2] = waiting list   (taurusmq:queue)
-- KEYS[3] = prioritized    (taurusmq:prioritized:queue)
-- KEYS[4] = batch:count    (taurusmq:batch:{id}:count)
-- KEYS[5] = delayed ZSET   (taurusmq:delayed:queue)
-- ARGV[1] = batchSize (N)
-- ARGV[2..N*5+1] = interleaved: jobId, jobJson, priority, timestamp, mode
--   mode: 0=waiting (priority>0 upgrades to prioritized), 2=delayed
--   For delayed items the timestamp field already holds executetime (set by
--   the JS sender), so no extra field is needed.

-- Score constants (freeze — changing invalidates existing scores)
local PRIORITY_SCALE = 100000000000   -- 1e11
local EPOCH_BASE = 1700000000000      -- 2023-11-14T22:13:20Z

local function calcScore(priority, timestamp)
    return priority * PRIORITY_SCALE + (timestamp - EPOCH_BASE)
end

-- Parse batch size
local batchSize = tonumber(ARGV[1])
local results = {}

-- Batch counter (KEYS[4] always passed — numberOfKeys guarantees it)
redis.call('SET', KEYS[4], batchSize)
redis.call('EXPIRE', KEYS[4], 7 * 24 * 60 * 60) -- 7 day TTL

-- Each item has exactly 5 fields: jobId, jobJson, priority, timestamp, mode
local argIdx = 2
for i = 1, batchSize do
    local jobId     = ARGV[argIdx]
    local jobJson   = ARGV[argIdx + 1]
    local priority  = tonumber(ARGV[argIdx + 2] or 0)
    local timestamp = tonumber(ARGV[argIdx + 3] or 0)
    local mode      = tonumber(ARGV[argIdx + 4] or 0)

    argIdx = argIdx + 5

    -- Atomic dedup per item
    if redis.call('HEXISTS', KEYS[1], jobId) == 1 then
        results[i] = 0 -- duplicate, skip
    else
        -- Store vault
        redis.call('HSET', KEYS[1], jobId, jobJson)

        if mode == 2 then
            -- Delayed: timestamp field already holds executetime (set by sender).
            -- No signal list here — caller pushes signals after the script
            redis.call('ZADD', KEYS[5], timestamp, jobId)
        else
            -- Default: waiting list (priority>0 upgrades to prioritized)
            if priority > 0 then
                local score = calcScore(priority, timestamp)
                redis.call('ZADD', KEYS[3], score, jobId)
            else
                redis.call('RPUSH', KEYS[2], jobId)
            end
        end

        results[i] = 1 -- created
    end
end

return results
