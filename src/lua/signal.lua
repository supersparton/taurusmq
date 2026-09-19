local jobid = ARGV[2];
local executetime = ARGV[1];

if(jobid) then
    redis.call('ZADD', KEYS[1],executetime,jobid);
    redis.call('LPUSH',KEYS[2],executetime);
end

return nil
