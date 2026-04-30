local jobstring = ARGV[1]
local jobid = ARGV[2]

if(jobid) then
    redis.call('HDEL',KEYS[1],jobid)
    redis.call('RPUSH',KEYS[2],jobstring)
    redis.call('LPUSH',KEYS[3],1)
end

return nil