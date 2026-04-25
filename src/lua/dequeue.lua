local jobjson = redis.call('LPOP',KEYS[1])

if jobjson then
    local job = cjson.decode(jobjson)
    local jobid = job.id
    redis.call('HSET',KEYS[2],jobid,jobjson)
    return jobjson
end

return nil
