local jobjson = ARGV[2];
local executetime = ARGV[1];

if(jobjson) then
    redis.call('LPUSH',KEYS[2],executetime);
    redis.call('ZADD', KEYS[1],executetime,jobjson);
end

return nil
