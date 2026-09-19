-- promoteIfUnblocked.lua
-- Atomic check-and-promote for DAG jobs whose parents all finished before
-- the child was even registered. Replaces the racy JS GET + 5-op sequence.
--
-- KEYS[1] = blocked hash   (taurusmq:blocked:queue)
-- KEYS[2] = prioritized    (taurusmq:prioritized:queue)
-- KEYS[3] = waiting list   (taurusmq:queue)
-- KEYS[4] = signal list    (taurusmq:signal:queue)
-- ARGV[1] = jobId
-- ARGV[2] = prefix
-- ARGV[3] = queueName
-- ARGV[4] = priority (0 if none)
-- ARGV[5] = timestamp
-- ARGV[6] = eventsChannel

-- Score constants (freeze — changing invalidates existing scores)
local PRIORITY_SCALE = 100000000000   -- 1e11
local EPOCH_BASE = 1700000000000      -- 2023-11-14T22:13:20Z

local function calcScore(priority, timestamp)
    return priority * PRIORITY_SCALE + (timestamp - EPOCH_BASE)
end

local jobId = ARGV[1]
local prefix = ARGV[2]
local queueName = ARGV[3]
local priority = tonumber(ARGV[4] or 0)
local timestamp = tonumber(ARGV[5] or 0)
local eventsChannel = ARGV[6]

-- Atomic read of counter (single GET, cannot interleave with DECR)
local currentCount = redis.call('GET', prefix .. ':job:' .. jobId .. ':count')

-- Guard: only promote if count exists AND is <= 0
-- count==nil means it was already cleaned up by unblock.lua — no-op
if currentCount and tonumber(currentCount) <= 0 then
    -- Cleanup tracking keys
    redis.call('DEL', prefix .. ':job:' .. jobId .. ':count')
    redis.call('DEL', prefix .. ':job:' .. jobId .. ':name')
    -- Remove from blocked
    redis.call('HDEL', KEYS[1], jobId)
    -- Promote to waiting or prioritized
    if priority > 0 then
        local score = calcScore(priority, timestamp)
        redis.call('ZADD', KEYS[2], score, jobId)
    else
        redis.call('RPUSH', KEYS[3], jobId)
    end
    -- Signal worker
    redis.call('LPUSH', KEYS[4], 1)
    -- Publish event
    redis.call('PUBLISH', eventsChannel, '{"event":"waiting","jobId":"' .. jobId .. '"}')
    return 1
end

return 0
