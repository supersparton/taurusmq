local jobs = redis.call('ZRANGEBYSCORE',KEYS[1],0,ARGV[1]);

if #jobs>0 then
   for i,job in ipairs(jobs) do
        redis.call('RPUSH',KEYS[2],job);
        redis.call('ZREM',KEYS[1],job);
    end
    redis.call('LPUSH', KEYS[3], #jobs) 
end

return #jobs