local Framework = {}

if Config.Framework == 'qb' then
    local QBCore = exports['qb-core']:GetCoreObject()
    
    function Framework:HasAccess()
        local PlayerData = QBCore.Functions.GetPlayerData()
        local grade_level = Config.BankerJobs[PlayerData.job.name]
        if not grade_level then return false end
        return PlayerData.job.grade.level >= grade_level
    end

    function Framework:GetPlayerInfo()
        local PlayerData = QBCore.Functions.GetPlayerData()
        return {
            fullname = PlayerData.charinfo.firstname .. " " .. PlayerData.charinfo.lastname,
            citizenid = PlayerData.citizenid
        }
    end
end

if Config.Framework == 'qbox' then
    function Framework:HasAccess()
        return exports.qbx_core:HasPrimaryGroup(Config.BankerJobs)
    end

    function Framework:GetPlayerInfo()
        local PlayerData = exports.qbx_core:GetPlayerData()
        return {
            fullname = PlayerData.charinfo.firstname .. " " .. PlayerData.charinfo.lastname,
            citizenid = PlayerData.citizenid
        }
    end
end

if Config.Framework == 'esx' then
    local ESX = exports.es_extended:getSharedObject()

    function Framework:HasAccess()
        local data = ESX.GetPlayerData()
        local grade_level = Config.BankerJobs[data.job.name]
        if not grade_level then return false end
        return data.job.grade >= grade_level
    end

    function Framework:GetPlayerInfo()
        local data = ESX.GetPlayerData()
        return {
            fullname = data.firstName .. " " .. data.lastName,
            citizenid = data.identifier
        }
    end
end

-- Keep your existing AddBoxZone logic below --
if Config.Target == 'qb' then
    function Framework:AddBoxZone(data, index)
        exports['qb-target']:AddBoxZone("loansystem"..index, data.coords, data.length, data.width, {
            name = "loansystem"..index,
            heading = data.heading,
            debugPoly = Config.debug,
            minZ = data.minZ,
            maxZ = data.maxZ,
        }, {
            options = {
                {
                    icon = 'fa fa-sitemap',
                    label = "Access Bank",
                    action = function() OpenMenu() end,
                },
                {
                    icon = 'fa fa-coins',
                    label = "Access Banker Menu",
                    action = function() OpenBankerMenu() end,
                    canInteract = function() return Framework:HasAccess() end,
                },
            },
            distance = 2.5,
        })
    end
elseif Config.Target == 'ox' then
    function Framework:AddBoxZone(data, _)
        exports.ox_target:addBoxZone({
            coords = data.coords,
            size = data.size,
            rotation = data.rotation,
            debug = Config.debug,
            options = {
                {
                    icon = 'fa fa-sitemap',
                    label = "Access Bank",
                    onSelect = function() OpenMenu() end,
                },
                {
                    icon = 'fa fa-coins',
                    label = "Access Banker Menu",
                    onSelect = function() OpenBankerMenu() end,
                    canInteract = function() return Framework:HasAccess() end,
                },
            }
        })
    end
end

return Framework