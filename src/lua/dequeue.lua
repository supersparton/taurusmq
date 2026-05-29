local jobid = redis.call('LPOP', KEYS[1])

if jobid then
    local jobjson = redis.call('HGET', KEYS[3], jobid)
    if jobjson then
        redis.call('HSET', KEYS[2], jobid, jobjson)
        return jobjson
    end
end
return nil
