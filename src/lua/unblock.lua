local parentId = KEYS[1]
local parent = ARGV[1]
local children = ARGV[2]
local childrenIds = redis.call('SMEMBERS', 'taurusmq:dependent:' .. parentId .. ':'..children..':')

for i, childId in ipairs(childrenIds) do
    
    local currentCount = redis.call('DECR', 'taurusmq:job:' .. childId .. ':count')
    
    if tonumber(currentCount) == 0 then
       
        local queueName = redis.call('GET', 'taurusmq:job:' .. childId .. ':name')
        
        local jobJson = redis.call('HGET', 'taurusmq:blocked:' .. queueName, childId)
        
        if jobJson then
            redis.call('RPUSH', 'taurusmq:' .. queueName, jobJson)
            redis.call('LPUSH', 'taurusmq:signal:' .. queueName, 1) 
            redis.call('HDEL', 'taurusmq:blocked:' .. queueName, childId)
        end
        
        redis.call('DEL', 'taurusmq:job:' .. childId .. ':count')
        redis.call('DEL', 'taurusmq:job:' .. childId .. ':name')

        redis.call('SREM', 'taurusmq:dependent:' .. parentId .. ':'..children..':' ,childId)
        redis.call('SREM', 'taurusmq:dependent:' .. childId ..':' ..parent.. ':',parentId)
        
    end
end



return #childrenIds
