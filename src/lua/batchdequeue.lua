local batchsize = tonumber(ARGV[1])
local waiting = redis.call('LRANGE', KEYS[1], 0, batchsize - 1)

if #waiting > 0 then
    for i, jobjson in ipairs(waiting) do
        local job = cjson.decode(jobjson)
        redis.call('HSET', KEYS[2], job.id, jobjson)
    end
    redis.call('LTRIM', KEYS[1], #waiting, -1)
end

return waiting
