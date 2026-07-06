local parentId = KEYS[1]
local parent = ARGV[1]
local children = ARGV[2]
local prefix = ARGV[3] or 'taurusmq'
local childrenIds = redis.call('SMEMBERS', prefix .. ':dependent:' .. parentId .. ':'..children..':')

for i, childId in ipairs(childrenIds) do
    
    -- 1. Always remove the relationship to prevent memory leaks
    redis.call('SREM', prefix .. ':dependent:' .. parentId .. ':'..children..':' ,childId)
    redis.call('SREM', prefix .. ':dependent:' .. childId ..':' ..parent.. ':',parentId)

    -- 2. Decrement the counter
    local currentCount = redis.call('DECR', prefix .. ':job:' .. childId .. ':count')
    
    if tonumber(currentCount) <= 0 then
        local queueName = redis.call('GET', prefix .. ':job:' .. childId .. ':name')
        
        if queueName then
            -- 3. Check if it's actually in the blocked state
            local isBlocked = redis.call('HEXISTS', prefix .. ':blocked:' .. queueName, childId)
            
            if isBlocked == 1 then
                -- 4. Move to Waiting or Prioritized (Job Vault architecture)
                local jobJson = redis.call('HGET', prefix .. ':jobs:' .. queueName, childId)
                local hasPriority = false
                local priorityVal = 0
                local timestampVal = 0
                if jobJson then
                    local jobObj = cjson.decode(jobJson)
                    if jobObj.priority then
                        local p = tonumber(jobObj.priority)
                        if p and p > 0 then
                            hasPriority = true
                            priorityVal = p
                            timestampVal = tonumber(jobObj.timestamp or 0)
                        end
                    end
                end

                if hasPriority then
                    local score = priorityVal * 100000000000 + (timestampVal - 1700000000000)
                    redis.call('ZADD', prefix .. ':prioritized:' .. queueName, score, childId)
                else
                    redis.call('RPUSH', prefix .. ':' .. queueName, childId)
                end
                redis.call('LPUSH', prefix .. ':signal:' .. queueName, 1) 
                redis.call('HDEL', prefix .. ':blocked:' .. queueName, childId)
                redis.call('PUBLISH', prefix .. ':' .. queueName .. ':events', '{"event":"waiting","jobId":"' .. childId .. '"}')
            end
            
            -- 5. Cleanup the tracking variables
            redis.call('DEL', prefix .. ':job:' .. childId .. ':count')
            redis.call('DEL', prefix .. ':job:' .. childId .. ':name')
        end
    end
end

return #childrenIds
