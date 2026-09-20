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
--
-- Parent-mode return codes: 0 = duplicate (already exists),
-- 1 = parked blocked, 2 = auto-promoted (all parents already finished).

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

-- Atomic dedup: if this id already exists, do nothing and return 0
if redis.call('HEXISTS', KEYS[1], jobId) == 1 then
    return 0
end

if mode == 'parent' then
    -- Parent (blocked) path: store vault + mark blocked + set counters + SADD relationships
    redis.call('HSET', KEYS[1], jobId, jobJson)

    -- Parse parent IDs from jobJson to SADD relationships
    local jobObj = cjson.decode(jobJson)
    local parents = jobObj.parent or {}
    for _, parentId in ipairs(parents) do
        redis.call('SADD', prefix .. ':dependent:' .. parentId .. ':children:', jobId)
        redis.call('SADD', prefix .. ':dependent:' .. jobId .. ':parent:', parentId)
    end

    -- Count only still-pending parents (same-queue completion check).
    -- A parent that already finished before this child registered must not
    -- be counted: otherwise the child strands blocked forever with nobody
    -- left to unblock it (its parents will never complete again).
    -- NOTE: cross-queue finished parents are not detectable here (no
    -- parent→queue mapping at registration) and still count as pending.
    local pending = 0
    for _, parentId in ipairs(parents) do
        local done = redis.call('ZSCORE', prefix .. ':completed:' .. queueName, parentId)
            or redis.call('HEXISTS', prefix .. ':dlq:' .. queueName, parentId) == 1
        if not done then
            pending = pending + 1
        end
    end

    if pending == 0 then
        -- All parents already finished: promote immediately instead of
        -- parking blocked. Caller skips promoteIfUnblocked on code 2.
        if priority > 0 then
            redis.call('ZADD', KEYS[4], calcScore(priority, timestamp), jobId)
        else
            redis.call('RPUSH', KEYS[2], jobId)
        end
        redis.call('LPUSH', KEYS[3], 1)
        return 2
    end

    redis.call('HSET', prefix .. ':blocked:' .. queueName, jobId, 1)
    redis.call('SET', prefix .. ':job:' .. jobId .. ':count', pending)
    redis.call('SET', prefix .. ':job:' .. jobId .. ':name', queueName)
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
