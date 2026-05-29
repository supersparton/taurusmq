local batchsize = tonumber(ARGV[1])
local waiting_ids = redis.call('LRANGE', KEYS[1], 0, batchsize - 1)
local results = {}

if #waiting_ids > 0 then
    for i, jobid in ipairs(waiting_ids) do
        local jobjson = redis.call('HGET', KEYS[3], jobid)
        if jobjson then
            redis.call('HSET', KEYS[2], jobid, jobjson)
            table.insert(results, jobjson)
        end
    end
    redis.call('LTRIM', KEYS[1], #waiting_ids, -1)
end

return results
