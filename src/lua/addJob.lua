-- addJob.lua
-- Unified atomic add for all job types.
-- KEYS[1] = jobs hash      e.g. taurusmq:jobs:myqueue
-- KEYS[2] = waiting list   e.g. taurusmq:myqueue
-- KEYS[3] = signal list    e.g. taurusmq:signal:myqueue
-- KEYS[4] = prioritized    e.g. taurusmq:prioritized:myqueue
-- ARGV[1] = jobId
-- ARGV[2] = jobJson
-- ARGV[3] = priority (0 if none)
-- ARGV[4] = timestamp (milliseconds)
-- ARGV[5] = mode: 'immediate' | 'parent'
-- ARGV[6] = prefix (for parent mode: taurusmq)
-- ARGV[7] = queueName (for parent mode: myqueue)
-- ARGV[8] = parentCount (for parent mode: number of parents)

-- Score constants (freeze — changing invalidates existing scores)
local PRIORITY_SCALE = 100000000000   -- 1e11
local EPOCH_BASE = 1700000000000      -- 2023-11-14T22:13:20Z

local function calcScore(priority, timestamp)
    return priority * PRIORITY_SCALE + (timestamp - EPOCH_BASE)
end

local jobId    = ARGV[1]
local jobJson  = ARGV[2]
local priority = tonumber(ARGV[3] or 0)
local timestamp = tonumber(ARGV[4] or 0)
local mode     = ARGV[5] or 'immediate'
local prefix   = ARGV[6] or 'taurusmq'
local queueName = ARGV[7] or ''
local parentCount = tonumber(ARGV[8] or 0)

-- Atomic dedup: if this id already exists, do nothing and return 0
if redis.call('HEXISTS', KEYS[1], jobId) == 1 then
    return 0
end

if mode == 'parent' then
    -- Parent (blocked) path: store vault + mark blocked + set counters + SADD relationships
    redis.call('HSET', KEYS[1], jobId, jobJson)
    redis.call('HSET', prefix .. ':blocked:' .. queueName, jobId, 1)
    redis.call('SET', prefix .. ':job:' .. jobId .. ':count', parentCount)
    redis.call('SET', prefix .. ':job:' .. jobId .. ':name', queueName)

    -- Parse parent IDs from jobJson to SADD relationships
    local jobObj = cjson.decode(jobJson)
    local parents = jobObj.parent or {}
    for _, parentId in ipairs(parents) do
        redis.call('SADD', prefix .. ':dependent:' .. parentId .. ':children:', jobId)
        redis.call('SADD', prefix .. ':dependent:' .. jobId .. ':parent:', parentId)
    end
else
    -- Immediate path: store vault + enqueue
    redis.call('HSET', KEYS[1], jobId, jobJson)
    if priority > 0 then
        local score = calcScore(priority, timestamp)
        redis.call('ZADD', KEYS[4], score, jobId)
    else
        redis.call('RPUSH', KEYS[2], jobId)
    end
    redis.call('LPUSH', KEYS[3], 1)
end

return 1
