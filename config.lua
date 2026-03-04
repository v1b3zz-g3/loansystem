Config = {}

Config.debug = false

Config.Framework = 'qb' -- 'qb', 'qbox', 'esx'
Config.Phone = 'qb'     -- 'qb', 'qs', 'lb', 'road', 'yseries', 'snappy-phone', 'none'
Config.Target = 'qb'    -- 'qb', 'ox'

if Config.Target == 'qb' then
    Config.TargetZones = {
        [1] = {
            name = 'Pacific Bank',
            coords = vector3(241.6, 226.2, 106.0),
            length = 3, width = 3, heading = 0,
            minZ = 104.0, maxZ = 108.0,
        }
    }
elseif Config.Target == 'ox' then
    Config.TargetZones = {
        [1] = {
            name = 'Pacific Bank',
            coords = vec3(241.6, 226.2, 106.0),
            size = vec3(1, 1, 2),
            rotation = 341.75,
        }
    }
end

Config.BankerJobs = {
    ["banker"] = 0,
}

Config.LoanIntervals       = 10 * 60 * 1000
Config.AutomaticDeduction  = true
Config.MaxActiveLoans      = 3   -- Maximum concurrent active loans per player

Config.LoanTypes = {
    { label = 'Personal Loan', value = 'Personal Loan', interest = 0.05 },
    { label = 'Business Loan', value = 'Business Loan', interest = 0.10 },
    { label = 'Home Loan',     value = 'Home Loan',     interest = 0.15 },
}

Config.Duration = {
    { label = '1 Week',  value = 1 },
    { label = '2 Weeks', value = 2 },
    { label = '3 Weeks', value = 3 },
    { label = '4 Weeks', value = 4 },
    
}

-- ═══════════════════════════════════════════════
--   CREDIT SCORE SYSTEM
-- ═══════════════════════════════════════════════
Config.CreditScore = {
    Enable                         = true,
    CreditScoreRequirementForLoans = true,
    Requirement = {
        ['Personal Loan'] = 0,
        ['Business Loan'] = 600,
        ['Home Loan']     = 100,
    },
    DefaultCreditScore = 500,
    MaxCreditScore     = 900,
    DefaultInterest    = 0.08,

    -- ── Named Score Events ──────────────────────
    -- These fire for specific lifecycle events
    Events = {
        HardInquiry         = -20,   -- Applied for a loan
        LoanApproved        =  15,   -- Banker approved your loan
        LoanRejected        = -10,   -- Banker rejected your loan
        FullPayoff          =  80,   -- Paid off an entire loan
        PerfectLoanBonus    =  50,   -- Paid every installment on time (no late payments)
        LatePaymentPenalty  = -75,   -- Missed a due date (auto-deducted)
        LoanDefault         = -200,  -- Failed auto-deduction (insufficient funds)
        DeferralRequested   = -30,   -- Requested a payment deferral
        MultipleDefaults    = -100,  -- Penalty for having 2+ defaults on record
    },

    -- ── Passive Recovery ───────────────────────
    -- Scores below RecoveryThreshold slowly climb back
    PassiveRecovery = {
        Enable            = true,
        PointsPerInterval = 5,
        IntervalHours     = 24,          -- Run once per 24 game-hours (server time)
        RecoveryThreshold = 600,         -- Only recover if score < this value
        MinScoreToRecover = 1,           -- Don't recover if blacklisted (score < 0)
    },

    -- ── Instalment-based scoring ───────────────
    -- (legacy — still used for payment amounts)
    Addon = {
        { score = 100, amount = 0    },
        { score = 200, amount = 1000 },
        { score = 300, amount = 2000 },
        { score = 400, amount = 3000 },
    },
    Deduct = {
        { score = 100, amount = 0    },
        { score = 200, amount = 500  },
        { score = 300, amount = 2000 },
        { score = 500, amount = 5000 },
    },

    -- ── Loan eligibility tiers ─────────────────
    OptLoan = {
        ['Personal Loan'] = {
            { minCreditScore = 0,   interest = 0.8,  maxAmount = 500    },
            { minCreditScore = 300, interest = 0.5,  maxAmount = 2000   },
            { minCreditScore = 500, interest = 0.2,  maxAmount = 50000  },
            { minCreditScore = 700, interest = 0.1,  maxAmount = 200000 },
        },
        ['Business Loan'] = {
            { minCreditScore = 600, interest = 0.15, maxAmount = 200000  },
            { minCreditScore = 700, interest = 0.12, maxAmount = 500000  },
            { minCreditScore = 800, interest = 0.08, maxAmount = 1000000 },
        },
        ['Home Loan'] = {
            { minCreditScore = 100, interest = 0.30, maxAmount = 500000   },
            { minCreditScore = 500, interest = 0.20, maxAmount = 2000000  },
            { minCreditScore = 700, interest = 0.15, maxAmount = 5000000  },
            { minCreditScore = 850, interest = 0.10, maxAmount = 10000000 },
        },
    },
}

-- ═══════════════════════════════════════════════
--   EARLY PAYOFF
-- ═══════════════════════════════════════════════
Config.EarlyPayoff = {
    Enable          = true,
    DiscountPercent = 0.10,   -- 10% discount on remaining balance if paid in full early
    MinWeeksRemaining = 1,    -- Must have at least this many weeks left to qualify
}

-- ═══════════════════════════════════════════════
--   PAYMENT DEFERRAL
-- ═══════════════════════════════════════════════
Config.Deferral = {
    Enable      = true,
    MaxPerLoan  = 2,          -- Maximum deferrals allowed per loan lifetime
    ExtendDays  = 7,          -- Shift due date forward by N days
}

-- ═══════════════════════════════════════════════
--   PHONE MAIL NOTIFICATIONS
-- ═══════════════════════════════════════════════
Config.PhoneMails = {
    DueReminder  = true,
    Time         = 20,       -- Days before due to send reminder
    ApproveMail  = true,
    DeclineMail  = true,
    DefaultMail  = true,     -- Send mail when a payment is auto-deducted / fails
    ScoreMail    = true,     -- Send mail when score changes significantly (±50+)
}
