local jobid = ARGV[2];
local executetime = ARGV[1];

if(jobid) then
    redis.call('LPUSH',KEYS[2],executetime);
    redis.call('ZADD', KEYS[1],executetime,jobid);
end

return nil
