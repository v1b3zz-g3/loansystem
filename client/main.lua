local Framework = require('client.utils')

function AlertBoxConfirmation(data)
    local alert = lib.alertDialog({
        header = data.header,
        content = data.content,
        centered = true,
        cancel = true
    })
    if not alert then return false end
    if alert == "confirm" then
        return true
    end
    return false
end

function SendMail(data)
    local input = lib.inputDialog("Send Mail", {
        {
            type = 'textarea',
            label = 'Subject',
            description = 'Enter the Subject you want to send',
            default = "#" .. data.loan_id .. " Loan Payment Reminder",
            required = true,
        },
        {
            type = 'textarea',
            label = 'Message',
            description = 'Enter the message you want to send',
            default = "You have a loan payment due . Please visit the bank to pay the amount",
            required = true,
        },
    })
    if not input then return end
    local sendMail = {
        subject = input[1],
        message = input[2],
        citizenid = data.citizenid,
    }
    TriggerServerEvent("loan-system:server:sendMail", sendMail)
end

-- Replaces OpenMenu and OpenBankerMenu to route into the unified NUI
local function OpenNUIDashboard(isBanker)
    local PlayerData = Framework:GetPlayerInfo()
    local scores = lib.callback.await('loan-system:server:getMyScores', false)
    local rawLoans = lib.callback.await('loan-system:server:getMyLoans', false)
    
    if Config.CreditScore.Enable then
        TriggerServerEvent("loan-system:server:firstTimeCredits")
    end

    -- Process data for Dashboard Metrics
    local totalBorrowed, totalOwed, appCount, missedPayments = 0, 0, #rawLoans, 0
    local formattedLoans = {}

    for _, v in pairs(rawLoans) do
        local details = json.decode(v.loan_details)
        if v.status == 1 then -- Approved & Active
            totalBorrowed = totalBorrowed + (tonumber(details.amount) or 0)
            totalOwed = totalOwed + (tonumber(details.remainingamount) or 0)
            
            -- Check missed payments
            for _, due in pairs(details.dues) do
                if not due.paid and GetCloudTimeAsInt() > due.time then
                    missedPayments = missedPayments + 1
                end
            end
        end
        
        table.insert(formattedLoans, {
            id = v.loan_id,
            type = details.loantype,
            amount = details.amount,
            remaining = details.remainingamount,
            status = v.status
        })
    end

    -- Estimate max credit line based on score loosely (visual only for dashboard)
    local maxEligibility = 0
    if Config.CreditScore.OptLoan['Personal Loan'] then
        for _, v in ipairs(Config.CreditScore.OptLoan['Personal Loan']) do
            if scores >= v.minCreditScore then maxEligibility = v.maxAmount end
        end
    end

    -- Compile Banker Data if they opened the Banker Menu
    local allBankerLoans = {}
    if isBanker then
        local bankerData = lib.callback.await('loan-system:server:getLoans', false)
        for _, v in pairs(bankerData.All) do
            local details = json.decode(v.loan_details)
            table.insert(allBankerLoans, {
                id = v.loan_id,
                citizenid = v.citizenid,
                name = details.name,
                type = details.loantype,
                amount = details.amount,
                remaining = details.remainingamount,
                status = v.status,
                raw_details = v.loan_details 
            })
        end
    end

    SetNuiFocus(true, true)
    SendNUIMessage({
        action = "open",
        payload = {
            playerName = PlayerData.fullname,
            score = scores,
            totalBorrowed = totalBorrowed,
            totalOwed = totalOwed,
            maxEligibility = maxEligibility,
            appCount = appCount,
            missedPayments = missedPayments,
            loans = formattedLoans,
            isBanker = isBanker,
            allLoans = allBankerLoans
        }
    })
end

function OpenMenu()
    OpenNUIDashboard(false)
end

function OpenBankerMenu()
    OpenNUIDashboard(true)
end

-- ================= NUI Callbacks =================

RegisterNUICallback('closeUI', function(_, cb)
    SetNuiFocus(false, false)
    SendNUIMessage({ action = "close" })
    cb('ok')
end)

RegisterNUICallback('applyLoan', function(data, cb)
    local scores = lib.callback.await('loan-system:server:getMyScores', false)
    local interest = Config.CreditScore.DefaultInterest

    if Config.CreditScore and Config.CreditScore.Enable then
        if scores < 0 then
            lib.notify({ description = "You have been blacklisted!", type = "error" })
            return cb('error')
        end
        
        local optLoans = Config.CreditScore.OptLoan[data.type]
        if optLoans then
            for k, currentRange in pairs(optLoans) do
                local nextRange = optLoans[k+1]
                if scores >= currentRange.minCreditScore and (not nextRange or scores < nextRange.minCreditScore) then
                    interest = currentRange.interest
                    if data.amount > currentRange.maxAmount then
                        lib.notify({ description = "Max eligible amount is $"..currentRange.maxAmount, type = "error" })
                        return cb('error')
                    end
                end
            end
        end
    end

    local serverData = {
        type = data.type,
        amount = data.amount,
        reason = data.reason,
        duration = data.duration,
        interest = tonumber(data.amount * data.duration * interest),
        interestpercent = interest,
    }
    
    local alertdata = {
        header = 'Confirm Loan',
        content = 'Are you sure you want to request a loan of $' .. serverData.amount .. ' for ' .. serverData.duration .. ' weeks with total interest of $' .. (serverData.interest) .. ' ?',
    }
    
    SetNuiFocus(false, false)
    SendNUIMessage({ action = "close" })
    
    local confirm = AlertBoxConfirmation(alertdata)
    if confirm then
        TriggerServerEvent('loan-system:server:requestLoan', serverData)
    end
    cb('ok')
end)

RegisterNUICallback('payLoanNUI', function(data, cb)
    local rawLoans = lib.callback.await('loan-system:server:getMyLoans', false)
    for _, v in pairs(rawLoans) do
        if v.loan_id == data.id then
            local details = json.decode(v.loan_details)
            for _, due in pairs(details.dues) do
                if not due.paid then
                    local alertdata = {
                        header = 'Pay Installment',
                        content = 'Are you sure you want to pay $' .. due.amount .. ' for due #' .. due.due .. ' ?',
                    }
                    SetNuiFocus(false, false)
                    SendNUIMessage({ action = "close" })
                    
                    local confirm = AlertBoxConfirmation(alertdata)
                    if confirm then
                        TriggerServerEvent("loan-system:server:payLoan", {
                            loan_id = v.loan_id,
                            citizenid = v.citizenid,
                            loan_details = v.loan_details,
                            payamount = due.amount,
                            due = due.due
                        })
                    end
                    break 
                end
            end
        end
    end
    cb('ok')
end)

RegisterNUICallback('bankerAction', function(data, cb)
    local action = data.action
    local loan = data.loan
    
    SetNuiFocus(false, false)
    SendNUIMessage({ action = "close" })

    -- We construct the object the server expects
    local serverData = {
        loan_id = loan.id,
        citizenid = loan.citizenid,
        loan_details = loan.raw_details
    }

    if action == 'approve' then
        TriggerServerEvent("loan-system:server:approveLoan", serverData)
    elseif action == 'reject' then
        local input = lib.inputDialog("Reject Loan", {
            { type = 'textarea', label = 'Reason', description = 'Enter the reason for rejecting this loan', required = true },
        })
        if input and input[1] then
            serverData.rejectionReason = input[1]
            TriggerServerEvent("loan-system:server:rejectLoan", serverData)
        end
    elseif action == 'mail' then
        SendMail(serverData)
    end
    
    cb('ok')
end)

CreateThread(function()
    for index, data in pairs(Config.TargetZones) do
        Framework:AddBoxZone(data, index)
    end
end)