local parentId = KEYS[1]
local parent = ARGV[1]
local children = ARGV[2]
local childrenIds = redis.call('SMEMBERS', 'taurusmq:dependent:' .. parentId .. ':'..children..':')

for i, childId in ipairs(childrenIds) do
    
    -- 1. Always remove the relationship to prevent memory leaks
    redis.call('SREM', 'taurusmq:dependent:' .. parentId .. ':'..children..':' ,childId)
    redis.call('SREM', 'taurusmq:dependent:' .. childId ..':' ..parent.. ':',parentId)

    -- 2. Decrement the counter
    local currentCount = redis.call('DECR', 'taurusmq:job:' .. childId .. ':count')
    
    if tonumber(currentCount) <= 0 then
        local queueName = redis.call('GET', 'taurusmq:job:' .. childId .. ':name')
        
        if queueName then
            -- 3. Check if it's actually in the blocked state
            local isBlocked = redis.call('HEXISTS', 'taurusmq:blocked:' .. queueName, childId)
            
            if isBlocked == 1 then
                -- 4. Move ID to Waiting List (Job Vault architecture)
                redis.call('RPUSH', 'taurusmq:' .. queueName, childId)
                redis.call('LPUSH', 'taurusmq:signal:' .. queueName, 1) 
                redis.call('HDEL', 'taurusmq:blocked:' .. queueName, childId)
            end
            
            -- 5. Cleanup the tracking variables
            redis.call('DEL', 'taurusmq:job:' .. childId .. ':count')
            redis.call('DEL', 'taurusmq:job:' .. childId .. ':name')
        end
    end
end

return #childrenIds
