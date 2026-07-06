-- drain.lua
-- KEYS[1] = waiting list       e.g. taurusmq:myqueue
-- KEYS[2] = prioritized ZSET   e.g. taurusmq:prioritized:myqueue
-- KEYS[3] = delayed ZSET       e.g. taurusmq:delayed:myqueue
-- KEYS[4] = jobs hash          e.g. taurusmq:jobs:myqueue
-- KEYS[5] = signal list        e.g. taurusmq:signal:myqueue
-- KEYS[6] = delayed signal list e.g. taurusmq:signal:delayed:myqueue

local waiting = redis.call('LRANGE', KEYS[1], 0, -1)
local prioritized = redis.call('ZRANGE', KEYS[2], 0, -1)
local delayed = redis.call('ZRANGE', KEYS[3], 0, -1)

local function deleteJobs(jobIds, hashKey)
    if #jobIds > 0 then
        for i = 1, #jobIds, 5000 do
            local chunk = {}
            for j = i, math.min(i + 4999, #jobIds) do
                table.insert(chunk, jobIds[j])
            end
            redis.call('HDEL', hashKey, unpack(chunk))
        end
    end
end

deleteJobs(waiting, KEYS[4])
deleteJobs(prioritized, KEYS[4])
deleteJobs(delayed, KEYS[4])

redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
redis.call('DEL', KEYS[5])
redis.call('DEL', KEYS[6])

return 1
