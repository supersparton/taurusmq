-- drain.lua
-- KEYS[1] = waiting list       e.g. taurusmq:myqueue
-- KEYS[2] = prioritized ZSET   e.g. taurusmq:prioritized:myqueue
-- KEYS[3] = delayed ZSET       e.g. taurusmq:delayed:myqueue
-- KEYS[4] = jobs hash          e.g. taurusmq:jobs:myqueue
-- KEYS[5] = signal list        e.g. taurusmq:signal:myqueue
-- KEYS[6] = delayed signal list e.g. taurusmq:signal:delayed:myqueue

-- Batched LRANGE/LTRIM: never load entire list at once.
-- Batches are capped at 500, so a single HDEL per batch suffices.
local function drainList(listKey, hashKey)
    while true do
        local batch = redis.call('LRANGE', listKey, 0, 499)
        if #batch == 0 then break end
        redis.call('HDEL', hashKey, unpack(batch))
        redis.call('LTRIM', listKey, #batch, -1)
    end
end

drainList(KEYS[1], KEYS[4])

-- ZSETs: delete in batches of 500
local function drainZset(zsetKey, hashKey)
    while true do
        local batch = redis.call('ZRANGE', zsetKey, 0, 499)
        if #batch == 0 then break end
        redis.call('HDEL', hashKey, unpack(batch))
        redis.call('ZREM', zsetKey, unpack(batch))
    end
end

drainZset(KEYS[2], KEYS[4])
drainZset(KEYS[3], KEYS[4])

redis.call('DEL', KEYS[5])
redis.call('DEL', KEYS[6])

return 1
