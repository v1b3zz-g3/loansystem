local Framework    = require('server.utils')
local resourceName = GetCurrentResourceName()

-- ═══════════════════════════════════════════════
--   IN-MEMORY WRITE-THROUGH CACHE
--   Populated on resource start from SQL.
--   Every write hits SQL immediately.
-- ═══════════════════════════════════════════════
local CreditScores = {}   -- { [cid] = score }

-- ═══════════════════════════════════════════════
--   SQL HELPERS — CREDIT SCORES
-- ═══════════════════════════════════════════════

--- Upsert a player's score in SQL and update the local cache.
local function dbSetScore(cid, score)
    CreditScores[cid] = score
    MySQL.Async.execute(
        'INSERT INTO players_credit_score (citizenid, score) VALUES (?, ?) ON DUPLICATE KEY UPDATE score = VALUES(score)',
        { cid, score }
    )
end

--- Insert a history row and prune rows beyond the latest 30 for this player.
local function dbPushHistory(cid, change, reason, newScore)
    MySQL.Async.execute(
        'INSERT INTO players_credit_history (citizenid, change_amount, reason, new_score, created_at) VALUES (?, ?, ?, ?, ?)',
        { cid, change, reason, newScore, os.time() }
    )
    MySQL.Async.execute([[
        DELETE FROM players_credit_history
        WHERE citizenid = ?
          AND id NOT IN (
            SELECT id FROM (
                SELECT id FROM players_credit_history
                WHERE citizenid = ?
                ORDER BY id DESC LIMIT 30
            ) AS keep
          )
    ]], { cid, cid })
end

-- ═══════════════════════════════════════════════
--   PUBLIC SCORE HELPERS
-- ═══════════════════════════════════════════════

function GetScores(cid)
    -- Prefer cache; fall back to live DB read only when needed.
    if CreditScores[cid] ~= nil then return CreditScores[cid] end
    local row = MySQL.single.await('SELECT score FROM players_credit_score WHERE citizenid = ?', { cid })
    if row then
        CreditScores[cid] = row.score
        return row.score
    end
    return 0
end

--- Apply a raw delta, clamp, persist, and record history.
local function applyScoreDelta(cid, delta, reason)
    local current = GetScores(cid)
    if current < 0 then return current end  -- blacklisted — no recovery

    local newScore = math.min(math.max(current + delta, 0), Config.CreditScore.MaxCreditScore)
    dbSetScore(cid, newScore)
    dbPushHistory(cid, delta, reason, newScore)
    return newScore
end

--- Fire a named credit-score event defined in Config.CreditScore.Events.
function HandleScoreEvent(cid, eventKey, overrideReason)
    if not Config.CreditScore.Enable then return end
    local delta = Config.CreditScore.Events[eventKey]
    if not delta then return end
    return applyScoreDelta(cid, delta, overrideReason or eventKey)
end

--- Legacy instalment-based scoring (on-time / late, amount-scaled).
function HandleScores(cid, operation, amount)
    if not Config.CreditScore.Enable then return end
    local rules = (operation == "add") and Config.CreditScore.Addon or Config.CreditScore.Deduct
    local score = 0
    for k, v in pairs(rules) do
        local nextKey = next(rules, k)
        if nextKey then
            if amount >= v.amount and amount < rules[nextKey].amount then
                score = v.score; break
            end
        else
            if amount >= v.amount then score = v.score; break end
        end
    end
    if score == 0 then return end
    local reason = (operation == "add") and "On-time payment" or "Late payment penalty"
    applyScoreDelta(cid, (operation == "add") and score or -score, reason)
end

--- Send a phone mail when a score changes significantly (±30+).
local function notifyScoreChange(cid, delta, reason)
    if not Config.PhoneMails.ScoreMail or Config.Phone == 'none' then return end
    if math.abs(delta) < 30 then return end
    local direction = delta > 0 and "increased" or "decreased"
    Framework:SendMail(cid, {
        sender  = "Pacific Bank — Credit Bureau",
        subject = "Credit Score Update",
        message = ("Your credit score has %s by %d points. Reason: %s. New score: %d."):format(
            direction, math.abs(delta), reason, GetScores(cid)
        ),
    })
end

-- ═══════════════════════════════════════════════
--   PASSIVE SCORE RECOVERY LOOP
--   Runs server-side on all players (online or not).
-- ═══════════════════════════════════════════════
local function passiveRecoveryLoop()
    if not Config.CreditScore.Enable or not Config.CreditScore.PassiveRecovery.Enable then return end
    local pr = Config.CreditScore.PassiveRecovery

    local rows = MySQL.query.await(
        'SELECT citizenid, score FROM players_credit_score WHERE score >= ? AND score < ?',
        { pr.MinScoreToRecover, pr.RecoveryThreshold }
    )
    for _, row in pairs(rows) do
        applyScoreDelta(row.citizenid, pr.PointsPerInterval, "Passive credit recovery")
    end

    SetTimeout(pr.IntervalHours * 60 * 60 * 1000, passiveRecoveryLoop)
end

-- ═══════════════════════════════════════════════
--   AUTOMATIC PAYMENT DEDUCTION LOOP
-- ═══════════════════════════════════════════════
local function loanPaidLoop()
    local data = MySQL.query.await('SELECT * FROM players_loan WHERE status = 1', {})
    for _, v in pairs(data) do
        local loanDetails = json.decode(v.loan_details)
        local changed = false
        for _, duesdata in pairs(loanDetails.dues) do
            if not duesdata.paid and os.time() >= duesdata.time then
                local removed = Framework:RemoveMoneyByIdentifier(v.citizenid, 'bank', tonumber(duesdata.amount), "banker-loan")
                if removed then
                    duesdata.paid         = true
                    duesdata.autoDeducted = true
                    HandleScores(v.citizenid, "remove", tonumber(duesdata.amount))
                    HandleScoreEvent(v.citizenid, "LatePaymentPenalty", "Missed instalment auto-collected")
                    notifyScoreChange(v.citizenid, Config.CreditScore.Events.LatePaymentPenalty, "Missed instalment auto-collected")

                    if not loanDetails.defaultCount then loanDetails.defaultCount = 0 end
                    loanDetails.defaultCount = loanDetails.defaultCount + 1
                    if loanDetails.defaultCount >= 2 then
                        HandleScoreEvent(v.citizenid, "MultipleDefaults", "Multiple missed payments")
                    end

                    if Config.PhoneMails.DefaultMail and Config.Phone ~= 'none' then
                        Framework:SendMail(v.citizenid, {
                            sender  = "Pacific Bank",
                            subject = "⚠️ Payment Auto-Deducted — Loan #" .. v.loan_id,
                            message = ("Loan #%d: Your overdue instalment of $%s has been automatically deducted. Your credit score has been penalised."):format(
                                v.loan_id, tostring(duesdata.amount)
                            ),
                        })
                    end
                else
                    -- Insufficient funds — hard default
                    Framework:RemoveMoneyByIdentifierOffline(v.citizenid, tonumber(duesdata.amount))
                    duesdata.paid         = true
                    duesdata.autoDeducted = true
                    duesdata.defaulted    = true
                    HandleScoreEvent(v.citizenid, "LoanDefault", "Payment default — insufficient funds")
                    notifyScoreChange(v.citizenid, Config.CreditScore.Events.LoanDefault, "Payment default — insufficient funds")
                end
                changed = true
            end
        end
        if changed then
            local allPaid = true
            for _, d in pairs(loanDetails.dues) do
                if not d.paid then allPaid = false; break end
            end
            MySQL.Async.execute('UPDATE players_loan SET status = ?, loan_details = ? WHERE loan_id = ?',
                { allPaid and 3 or 1, json.encode(loanDetails), v.loan_id })
        end
    end
    SetTimeout(Config.LoanIntervals, loanPaidLoop)
end

-- ═══════════════════════════════════════════════
--   RESOURCE LIFECYCLE
-- ═══════════════════════════════════════════════
AddEventHandler('onResourceStart', function(res)
    if GetCurrentResourceName() ~= res then return end

    -- Warm the in-memory cache from SQL after tables are ready
    Wait(500)
    local rows = MySQL.query.await('SELECT citizenid, score FROM players_credit_score', {})
    for _, row in pairs(rows) do
        CreditScores[row.citizenid] = row.score
    end
    print(("^2[sf_loansystem]^7 Loaded %d credit score(s) from SQL into cache."):format(#rows))

    -- Start auto-deduction loop
    if Config.AutomaticDeduction then
        Wait(5000)
        loanPaidLoop()
    end

    -- Start passive recovery loop
    if Config.CreditScore.Enable and Config.CreditScore.PassiveRecovery.Enable then
        Wait(10000)
        passiveRecoveryLoop()
    end

    -- Send due-date reminders on restart
    if Config.Phone ~= 'none' and Config.PhoneMails.DueReminder then
        local loans = MySQL.query.await('SELECT * FROM players_loan WHERE status = 1', {})
        for _, v in pairs(loans) do
            local ld = json.decode(v.loan_details)
            for _, d in pairs(ld.dues or {}) do
                if not d.paid then
                    local windowStart = d.time - (Config.PhoneMails.Time * 86400)
                    if os.time() >= windowStart and os.time() < d.time then
                        Framework:SendMail(v.citizenid, {
                            sender  = "Banker",
                            subject = "#" .. v.loan_id .. " Loan Payment Reminder",
                            message = "You have a loan payment due before " ..
                                os.date("%d-%m-%Y %H:%M:%S", d.time) .. ". Amount: $" .. d.amount,
                        })
                    end
                end
            end
        end
    end
end)

-- ═══════════════════════════════════════════════
--   CALLBACKS
-- ═══════════════════════════════════════════════

lib.callback.register('loan-system:server:getMyScores', function(source)
    local Player = Framework:GetPlayer(source)
    if not Player then return 0 end
    return GetScores(Player.citizenid)
end)

lib.callback.register('loan-system:server:getMyScoreHistory', function(source)
    local Player = Framework:GetPlayer(source)
    if not Player then return {} end
    local rows = MySQL.query.await(
        'SELECT change_amount, reason, new_score, created_at FROM players_credit_history WHERE citizenid = ? ORDER BY id DESC LIMIT 30',
        { Player.citizenid }
    )
    local out = {}
    for _, r in pairs(rows) do
        table.insert(out, {
            change   = r.change_amount,
            reason   = r.reason,
            newScore = r.new_score,
            time     = r.created_at,
        })
    end
    return out
end)

lib.callback.register('loan-system:server:getMyLoans', function(source)
    local Player = Framework:GetPlayer(source)
    local cid    = Player.citizenid
    local data   = MySQL.query.await('SELECT * FROM players_loan WHERE citizenid = ?', { cid })
    for _, row in pairs(data) do
        local ld = json.decode(row.loan_details)
        local function conv(f) if ld[f] then ld["converted"..f] = os.date("%c", tonumber(ld[f])) end end
        conv("starttime"); conv("endtime"); conv("requestedtime")
        for _, d in pairs(ld.dues or {}) do
            if d.time then d.convertedtime = os.date("%c", tonumber(d.time)) end
        end
        row.loan_details = json.encode(ld)
    end
    return data
end)

lib.callback.register('loan-system:server:getLoans', function(source)
    local data     = MySQL.query.await('SELECT * FROM players_loan', {})
    local out      = { Pending = {}, Approved = {}, Rejected = {}, Paid = {}, All = {} }
    local statusMap = { [0]="Pending", [1]="Approved", [2]="Rejected", [3]="Paid" }
    for _, v in pairs(data) do
        local ld = json.decode(v.loan_details)
        local function conv(f) if ld[f] then ld["converted"..f] = os.date("%c", tonumber(ld[f])) end end
        conv("starttime"); conv("endtime"); conv("requestedtime")
        for _, d in pairs(ld.dues or {}) do
            if d.time then d.convertedtime = os.date("%c", tonumber(d.time)) end
        end
        v.loan_details = json.encode(ld)
        local key = statusMap[v.status] or "All"
        if out[key] then table.insert(out[key], v) end
        table.insert(out.All, v)
    end
    return out
end)

lib.callback.register('loan-system:server:getActiveLoansCount', function(source)
    local Player = Framework:GetPlayer(source)
    if not Player then return 0 end
    local result = MySQL.single.await(
        'SELECT COUNT(*) AS cnt FROM players_loan WHERE citizenid = ? AND status = 1',
        { Player.citizenid }
    )
    return result and result.cnt or 0
end)

-- ═══════════════════════════════════════════════
--   LOAN REQUEST
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:requestLoan", function(data)
    local src    = source
    local Player = Framework:GetPlayer(src)
    if not Player then return end
    local cid = Player.citizenid

    local countResult = MySQL.single.await(
        'SELECT COUNT(*) AS cnt FROM players_loan WHERE citizenid = ? AND status = 1', { cid }
    )
    if (countResult and countResult.cnt or 0) >= Config.MaxActiveLoans then
        TriggerClientEvent("ox_lib:notify", src, {
            description = "You already have the maximum number of active loans (" .. Config.MaxActiveLoans .. ").",
            type = "error"
        })
        return
    end

    if tonumber(data.amount) < 0 then
        TriggerClientEvent("ox_lib:notify", src, { description = "Invalid loan amount.", type = "error" })
        return
    end

    local scoreBefore = GetScores(cid)
    HandleScoreEvent(cid, "HardInquiry", "Hard inquiry — loan application")
    notifyScoreChange(cid, GetScores(cid) - scoreBefore, "Hard inquiry")

    local totalamount = tonumber(data.amount) + tonumber(data.interest)
    local saveData = {
        name            = Player.fullname,
        loantype        = data.type,
        amount          = totalamount,
        remainingamount = totalamount,
        reason          = data.reason,
        duration        = data.duration,
        requestedamount = data.amount,
        interest        = data.interestpercent,
        requestedtime   = os.time(),
        deferralsUsed   = 0,
        defaultCount    = 0,
    }
    MySQL.Async.execute(
        'INSERT INTO players_loan (citizenid, loan_details) VALUES (?, ?)',
        { cid, json.encode(saveData) }
    )
    TriggerClientEvent("ox_lib:notify", src, {
        description = "Loan request submitted. Your credit score was reduced by " ..
            math.abs(Config.CreditScore.Events.HardInquiry) .. " points (hard inquiry).",
        type = "success"
    })
end)

-- ═══════════════════════════════════════════════
--   APPROVE LOAN
-- ═══════════════════════════════════════════════
RegisterNetEvent('loan-system:server:approveLoan', function(data)
    local src = source
    local cid = data.citizenid
    local ld  = json.decode(data.loan_details)

    local intervals, totalMoney = {}, 0
    for i = 1, tonumber(ld.duration) do
        local t     = os.time() + (i * 7 * 86400)
        local money = tonumber(string.format("%.0f", ld.amount / tonumber(ld.duration)))
        if i == tonumber(ld.duration) then money = tonumber(ld.amount) - tonumber(totalMoney) end
        table.insert(intervals, { amount = money, time = t, paid = false, due = i })
        totalMoney = totalMoney + tonumber(string.format("%.0f", ld.amount / tonumber(ld.duration)))
    end
    ld.starttime = os.time()
    ld.endtime   = os.time() + tonumber(ld.duration * 7 * 86400)
    ld.dues      = intervals

    MySQL.Async.execute('UPDATE players_loan SET status = 1, loan_details = ? WHERE loan_id = ?',
        { json.encode(ld), data.loan_id })

    local added = Framework:AddMoneyByIdentifier(cid, 'bank', tonumber(ld.requestedamount), "banker-loan")
    if not added then Framework:AddMoneyByIdentifierOffline(cid, tonumber(ld.requestedamount)) end

    HandleScoreEvent(cid, "LoanApproved", "Loan approved by banker")

    if Config.Phone ~= 'none' and Config.PhoneMails.ApproveMail then
        Framework:SendMail(cid, {
            sender  = "Banker",
            subject = "#" .. data.loan_id .. " Loan Approved",
            message = "Your loan of $" .. ld.requestedamount .. " has been approved and deposited.",
        })
    end
    TriggerClientEvent("ox_lib:notify", src, { description = "#" .. data.loan_id .. " Loan Approved!", type = "success" })
end)

-- ═══════════════════════════════════════════════
--   REJECT LOAN
-- ═══════════════════════════════════════════════
RegisterNetEvent('loan-system:server:rejectLoan', function(data)
    local src = source
    local cid = data.citizenid
    local ld  = json.decode(data.loan_details)
    ld.rejectionReason = data.rejectionReason

    MySQL.Async.execute('UPDATE players_loan SET status = 2, loan_details = ? WHERE loan_id = ?',
        { json.encode(ld), data.loan_id })

    HandleScoreEvent(cid, "LoanRejected", "Loan application rejected")

    if Config.Phone ~= 'none' and Config.PhoneMails.DeclineMail then
        Framework:SendMail(cid, {
            sender  = "Banker",
            subject = "#" .. data.loan_id .. " Loan Declined",
            message = "Reason: " .. data.rejectionReason .. ". Amount: $" .. ld.requestedamount .. ".",
        })
    end
    TriggerClientEvent("ox_lib:notify", src, { description = "#" .. data.loan_id .. " Loan Rejected!", type = "error" })
end)

-- ═══════════════════════════════════════════════
--   PAY INSTALMENT
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:payLoan", function(data)
    local src = source
    local cid = data.citizenid
    local ld  = json.decode(data.loan_details)

    if not Framework:RemoveMoneyByIdentifier(cid, 'bank', tonumber(data.payamount), "banker-loan") then
        TriggerClientEvent("ox_lib:notify", src, { description = "Insufficient funds!", type = "error" })
        return
    end

    ld.remainingamount = tonumber(ld.remainingamount) - tonumber(data.payamount)
    for _, v in pairs(ld.dues) do
        if v.due == tonumber(data.due) then
            v.paid = true
            if os.time() > v.time then
                HandleScores(cid, "remove", tonumber(data.payamount))
            else
                HandleScores(cid, "add",    tonumber(data.payamount))
            end
        end
    end

    local allPaid, anyLate = true, false
    for _, d in pairs(ld.dues) do
        if not d.paid then allPaid = false end
        if d.autoDeducted or d.defaulted then anyLate = true end
    end

    local newStatus = 1
    if allPaid then
        newStatus = 3
        local scoreBefore = GetScores(cid)
        HandleScoreEvent(cid, "FullPayoff", "Loan fully paid off")
        if not anyLate then
            HandleScoreEvent(cid, "PerfectLoanBonus", "Perfect payment record on loan #" .. data.loan_id)
        end
        notifyScoreChange(cid, GetScores(cid) - scoreBefore, "Loan fully paid off")
        TriggerClientEvent("ox_lib:notify", src, { description = "🎉 Loan fully paid off! Credit score boosted.", type = "success" })
    else
        TriggerClientEvent("ox_lib:notify", src, { description = "Payment of $" .. data.payamount .. " successful!", type = "success" })
    end

    MySQL.Async.execute('UPDATE players_loan SET status = ?, loan_details = ? WHERE loan_id = ?',
        { newStatus, json.encode(ld), data.loan_id })
end)

-- ═══════════════════════════════════════════════
--   EARLY PAYOFF
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:earlyPayoff", function(data)
    if not Config.EarlyPayoff.Enable then return end
    local src = source
    local cid = data.citizenid
    local ld  = json.decode(data.loan_details)

    local remaining   = tonumber(ld.remainingamount)
    local discountAmt = math.floor(remaining * Config.EarlyPayoff.DiscountPercent)
    local payAmount   = remaining - discountAmt

    if not Framework:RemoveMoneyByIdentifier(cid, 'bank', payAmount, "banker-loan-early-payoff") then
        TriggerClientEvent("ox_lib:notify", src, {
            description = "Insufficient funds for early payoff! Need $" .. payAmount,
            type = "error"
        })
        return
    end

    for _, d in pairs(ld.dues) do
        if not d.paid then d.paid = true; d.earlyPayoff = true end
    end
    ld.remainingamount = 0
    ld.earlyPayoffTime = os.time()

    MySQL.Async.execute('UPDATE players_loan SET status = 3, loan_details = ? WHERE loan_id = ?',
        { json.encode(ld), data.loan_id })

    local scoreBefore = GetScores(cid)
    HandleScoreEvent(cid, "FullPayoff",       "Early full loan payoff")
    HandleScoreEvent(cid, "PerfectLoanBonus", "Early payoff bonus — loan #" .. data.loan_id)
    notifyScoreChange(cid, GetScores(cid) - scoreBefore, "Early loan payoff")

    TriggerClientEvent("ox_lib:notify", src, {
        description = ("🎉 Early payoff! Saved $%d (%.0f%% discount). Credit score boosted!"):format(
            discountAmt, Config.EarlyPayoff.DiscountPercent * 100
        ),
        type = "success"
    })
end)

-- ═══════════════════════════════════════════════
--   PAYMENT DEFERRAL
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:deferPayment", function(data)
    if not Config.Deferral.Enable then return end
    local src = source
    local ld  = json.decode(data.loan_details)

    if not ld.deferralsUsed then ld.deferralsUsed = 0 end
    if ld.deferralsUsed >= Config.Deferral.MaxPerLoan then
        TriggerClientEvent("ox_lib:notify", src, {
            description = "Maximum deferrals reached (" .. Config.Deferral.MaxPerLoan .. ").",
            type = "error"
        })
        return
    end

    local extendMs = Config.Deferral.ExtendDays * 86400
    local deferred = false
    for _, d in pairs(ld.dues) do
        if not d.paid then
            d.time           = d.time + extendMs
            d.convertedtime  = os.date("%c", d.time)
            d.deferred       = true
            ld.deferralsUsed = ld.deferralsUsed + 1
            deferred         = true
            break
        end
    end

    if not deferred then
        TriggerClientEvent("ox_lib:notify", src, { description = "No outstanding dues to defer.", type = "error" })
        return
    end

    MySQL.Async.execute('UPDATE players_loan SET loan_details = ? WHERE loan_id = ?',
        { json.encode(ld), data.loan_id })

    HandleScoreEvent(data.citizenid, "DeferralRequested", "Payment deferral on loan #" .. data.loan_id)

    if Config.Phone ~= 'none' then
        Framework:SendMail(data.citizenid, {
            sender  = "Pacific Bank",
            subject = "Payment Deferral Granted — Loan #" .. data.loan_id,
            message = ("Payment deferred by %d days. Credit score reduced by %d pts. Deferrals remaining: %d."):format(
                Config.Deferral.ExtendDays,
                math.abs(Config.CreditScore.Events.DeferralRequested),
                Config.Deferral.MaxPerLoan - ld.deferralsUsed
            ),
        })
    end
    TriggerClientEvent("ox_lib:notify", src, { description = "Payment deferred by " .. Config.Deferral.ExtendDays .. " days.", type = "success" })
end)

-- ═══════════════════════════════════════════════
--   SEND MAIL (banker manual)
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:sendMail", function(data)
    local src = source
    Framework:SendMail(data.citizenid, {
        sender  = "Pacific Bank",
        subject = data.subject,
        message = data.message,
    })
    TriggerClientEvent("ox_lib:notify", src, { description = "Mail sent!", type = "success" })
end)

-- ═══════════════════════════════════════════════
--   FIRST-TIME CREDIT INITIALISATION
-- ═══════════════════════════════════════════════
RegisterNetEvent("loan-system:server:firstTimeCredits", function()
    local Player = Framework:GetPlayer(source)
    if not Player then return end
    local cid = Player.citizenid

    -- Only create a row if one doesn't already exist
    local existing = MySQL.single.await(
        'SELECT citizenid FROM players_credit_score WHERE citizenid = ?', { cid }
    )
    if not existing then
        local defaultScore = Config.CreditScore.DefaultCreditScore
        dbSetScore(cid, defaultScore)
        dbPushHistory(cid, 0, "Account opened — default score assigned", defaultScore)
        print(("^2[sf_loansystem]^7 Initialised credit score for %s → %d"):format(cid, defaultScore))
    end
end)

-- ═══════════════════════════════════════════════
--   DATABASE INIT
--   Creates all three tables if they don't exist.
-- ═══════════════════════════════════════════════
MySQL.ready(function()
    -- players_loan
    local ok = pcall(MySQL.query.await, "SELECT 1 FROM players_loan LIMIT 1")
    if not ok then
        MySQL.query.await([[
            CREATE TABLE IF NOT EXISTS `players_loan` (
                `loan_id`      int(11)   NOT NULL AUTO_INCREMENT,
                `citizenid`    varchar(50) NOT NULL DEFAULT '0',
                `loan_details` longtext  CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
                               CHECK (json_valid(`loan_details`)),
                `status`       int(11)   NOT NULL DEFAULT 0,
                PRIMARY KEY (`loan_id`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ]])
        print("^2[sf_loansystem]^7 Created table 'players_loan'.")
    end

    -- players_credit_score
    local okScore = pcall(MySQL.query.await, "SELECT 1 FROM players_credit_score LIMIT 1")
    if not okScore then
        MySQL.query.await([[
            CREATE TABLE IF NOT EXISTS `players_credit_score` (
                `citizenid` varchar(50) NOT NULL,
                `score`     int(11)     NOT NULL DEFAULT 500,
                PRIMARY KEY (`citizenid`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ]])
        print("^2[sf_loansystem]^7 Created table 'players_credit_score'.")
    end

    -- players_credit_history
    local okHist = pcall(MySQL.query.await, "SELECT 1 FROM players_credit_history LIMIT 1")
    if not okHist then
        MySQL.query.await([[
            CREATE TABLE IF NOT EXISTS `players_credit_history` (
                `id`            int(11)      NOT NULL AUTO_INCREMENT,
                `citizenid`     varchar(50)  NOT NULL,
                `change_amount` int(11)      NOT NULL DEFAULT 0,
                `reason`        varchar(255) NOT NULL DEFAULT '',
                `new_score`     int(11)      NOT NULL DEFAULT 0,
                `created_at`    int(11)      NOT NULL DEFAULT 0,
                PRIMARY KEY (`id`),
                KEY `idx_citizenid` (`citizenid`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
        ]])
        print("^2[sf_loansystem]^7 Created table 'players_credit_history'.")
    end
end)