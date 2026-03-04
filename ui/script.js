/* ═══════════════════════════════════════════
   PACIFIC BANK — NUI CONTROLLER v2
   New: score history, dues timeline, early payoff,
        deferral, loan limits, sparkline chart
═══════════════════════════════════════════ */

'use strict';

// ── State ──────────────────────────────────
let allBankerLoans   = [];
let currentPayload   = {};
let sessionStart     = Date.now();
let scoreHistory     = [];
let earlyPayoffPct   = 0.10;

const INTEREST_RATES = {
    'Personal Loan': 0.05,
    'Business Loan': 0.10,
    'Home Loan':     0.15
};

const HARD_INQUIRY_PENALTY = 20;

// ── Helpers ─────────────────────────────────
const fmt  = (n) => '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => (parseFloat(n) || 0).toLocaleString('en-US');
const el   = (id)  => document.getElementById(id);

function getResource() {
    try { return GetParentResourceName(); }
    catch { return 'sf_loansystem'; }
}

// ── Session clock ────────────────────────────
function updateClock() {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    const clockEl = el('session-time');
    if (clockEl) clockEl.textContent = `${h}:${m}:${s}`;
}
setInterval(updateClock, 1000);

// ── NUI Message handler ──────────────────────
window.addEventListener('message', (event) => {
    const { action, payload } = event.data;

    if (action === 'open') {
        sessionStart      = Date.now();
        currentPayload    = payload;
        scoreHistory      = payload.scoreHistory || [];
        earlyPayoffPct    = payload.earlyPayoffDiscount || 0.10;

        document.getElementById('app').classList.remove('hidden');

        // Banker tab
        const bankerNav = el('nav-banker');
        if (payload.isBanker) {
            bankerNav.classList.remove('hidden');
            allBankerLoans = payload.allLoans || [];
            el('banker-badge').textContent = allBankerLoans.filter(l => l.status === 0).length;
            renderBankerLoans();
        } else {
            bankerNav.classList.add('hidden');
        }

        updateDashboard(payload);
        renderScoreHistory(scoreHistory);
        switchTab('overview');

    } else if (action === 'close') {
        document.getElementById('app').classList.add('hidden');
    }
});

// ── ESC to close ─────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeUI();
});

// ── Tab navigation ───────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.target));
    });

    el('btn-header-apply').addEventListener('click', () => switchTab('apply'));

    ['loan-amount', 'loan-type', 'loan-duration'].forEach(id => {
        el(id)?.addEventListener('input', updatePreview);
        el(id)?.addEventListener('change', updatePreview);
    });

    el('loan-form').addEventListener('submit', (e) => {
        e.preventDefault();
        submitLoan();
    });

    el('banker-search').addEventListener('input', renderBankerLoans);
    el('banker-filter').addEventListener('change', renderBankerLoans);
});

function switchTab(target) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    const navBtn = document.querySelector(`.nav-btn[data-target="${target}"]`);
    const tabEl  = el(target);
    if (navBtn) navBtn.classList.add('active');
    if (tabEl)  tabEl.classList.add('active');
    if (target === 'score-history') renderScoreSparkline(scoreHistory);
}

// ── Dashboard ─────────────────────────────────
function updateDashboard(p) {
    el('welcome-text').textContent = `Welcome back, ${p.playerName} 👋`;

    el('metric-active-loans').textContent = fmt(p.totalBorrowed);
    el('metric-credit-line').textContent  = fmt(p.maxEligibility);
    el('metric-applications').textContent = fmtN(p.appCount);
    el('metric-money-owed').textContent   = fmt(p.totalOwed);

    // Loan count limit display
    const limitRow = el('loan-limit-row');
    if (limitRow && p.maxActiveLoans) {
        const active = p.activeLoansCount || 0;
        const max    = p.maxActiveLoans;
        const pct    = (active / max) * 100;
        const color  = active >= max ? 'var(--red)' : active >= max - 1 ? 'var(--yellow)' : 'var(--green)';
        limitRow.innerHTML = `
            <div class="mini-limit-bar">
                <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
                    <span style="font-size:9px;color:var(--text-muted);letter-spacing:1px;">LOAN SLOTS</span>
                    <span style="font-size:9px;font-family:var(--font-mono);color:${color};">${active}/${max}</span>
                </div>
                <div style="height:3px;background:var(--bg-input);border-radius:2px;overflow:hidden;">
                    <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width 0.8s ease;"></div>
                </div>
            </div>`;
    }

    // Missed payments
    const missedEl   = el('metric-missed');
    const missedSub  = el('missed-sub');
    const missedCard = missedEl?.closest('.metric-card');
    missedEl.textContent = fmtN(p.missedPayments);
    if (p.missedPayments > 0) {
        missedEl.style.color = 'var(--red)';
        if (missedSub) missedSub.textContent = `${p.missedPayments} overdue payment${p.missedPayments > 1 ? 's' : ''}`;
        missedCard?.classList.add('danger-card');
    } else {
        missedEl.style.color = 'var(--green)';
        if (missedSub) missedSub.textContent = 'All payments on time';
        missedCard?.classList.remove('danger-card');
    }

    animateCreditScore(p.score || 0);

    // Summary strip
    const acctStatus    = el('account-status');
    const scoreCategory = el('score-category');
    const scoreTrend    = el('score-trend');
    const nextAction    = el('next-action');

    if (p.missedPayments > 0) {
        acctStatus.textContent  = 'PAYMENTS OVERDUE';
        acctStatus.className    = 'summary-value status-bad';
    } else if (p.totalOwed > 0) {
        acctStatus.textContent  = 'ACTIVE LOANS';
        acctStatus.className    = 'summary-value accent-yellow';
    } else {
        acctStatus.textContent  = 'GOOD STANDING';
        acctStatus.className    = 'summary-value status-ok';
    }

    if (scoreCategory) {
        const { label } = getScoreInfo(p.score || 0);
        scoreCategory.textContent = label;
    }

    if (scoreTrend && scoreHistory.length >= 2) {
        const last   = scoreHistory[0];
        const prev   = scoreHistory[1];
        const delta  = last.newScore - prev.newScore;
        if (delta > 0) {
            scoreTrend.textContent = `▲ +${delta} pts`;
            scoreTrend.style.color = 'var(--green)';
        } else if (delta < 0) {
            scoreTrend.textContent = `▼ ${delta} pts`;
            scoreTrend.style.color = 'var(--red)';
        } else {
            scoreTrend.textContent = '— Stable';
            scoreTrend.style.color = 'var(--text-secondary)';
        }
    } else if (scoreTrend) {
        scoreTrend.textContent = '— No data';
        scoreTrend.style.color = 'var(--text-muted)';
    }

    if (nextAction) {
        if (p.totalOwed > 0) nextAction.textContent = 'Make a payment';
        else if ((p.activeLoansCount || 0) >= (p.maxActiveLoans || 3)) nextAction.textContent = 'Loan slots full';
        else nextAction.textContent = 'Apply for a loan';
    }

    // Apply-tab: loan limit warning
    const limitWarn = el('loan-limit-warning');
    const limitText = el('loan-limit-warning-text');
    if (limitWarn && limitText && p.maxActiveLoans) {
        const active = p.activeLoansCount || 0;
        const max    = p.maxActiveLoans;
        if (active >= max) {
            limitWarn.classList.remove('hidden');
            limitText.textContent = `You already have ${active}/${max} active loans. Repay an existing loan to apply for a new one.`;
            const submitBtn = el('form-submit-btn');
            if (submitBtn) submitBtn.disabled = true;
        } else {
            limitWarn.classList.add('hidden');
        }
    }

    renderMyLoans(p.loans || []);
    renderLoanHistory(p.loans || []);
    renderUpcomingDues(p.loans || []);

    updatePreview();
}

// ── Credit Score Animation ────────────────────
let scoreAnimFrame = null;

function animateCreditScore(targetScore) {
    const scoreEl    = el('metric-credit-score');
    const progressEl = el('credit-progress');
    const ratingEl   = el('score-rating');
    const MAX_SCORE  = 900;

    if (scoreAnimFrame) cancelAnimationFrame(scoreAnimFrame);

    let current = 0;
    const start    = performance.now();
    const duration = 1200;

    function step(now) {
        const t      = Math.min((now - start) / duration, 1);
        const eased  = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        current      = Math.round(eased * targetScore);

        scoreEl.textContent = fmtN(current);
        const pct           = (current / MAX_SCORE) * 100;
        progressEl.style.width = `${pct}%`;

        const { color, label } = getScoreInfo(current);
        progressEl.style.background = color;
        if (ratingEl) { ratingEl.textContent = label; ratingEl.style.color = color; }

        if (t < 1) scoreAnimFrame = requestAnimationFrame(step);
    }
    scoreAnimFrame = requestAnimationFrame(step);
}

function getScoreInfo(score) {
    if (score < 0)   return { color: '#8b0000',        label: 'BLACKLISTED' };
    if (score < 300) return { color: 'var(--red)',      label: 'VERY POOR'  };
    if (score < 500) return { color: '#ff6b35',         label: 'POOR'       };
    if (score < 650) return { color: 'var(--yellow)',   label: 'FAIR'       };
    if (score < 750) return { color: '#7ecba1',         label: 'GOOD'       };
    if (score < 850) return { color: 'var(--green)',    label: 'VERY GOOD'  };
    return                   { color: '#00ffaa',        label: 'EXCELLENT'  };
}

// ── Repayment Preview ─────────────────────────
function updatePreview() {
    const amount   = parseFloat(el('loan-amount')?.value) || 0;
    const duration = parseInt(el('loan-duration')?.value)  || 1;
    const type     = el('loan-type')?.value || 'Personal Loan';
    const rate     = INTEREST_RATES[type] || 0.05;

    const interest    = amount * duration * rate;
    const total       = amount + interest;
    const installment = duration > 0 ? total / duration : total;

    // Early payoff
    const earlyDiscount = Math.floor(total * earlyPayoffPct);
    const earlyTotal    = total - earlyDiscount;

    el('prev-principal').textContent   = fmt(amount);
    el('prev-interest').textContent    = fmt(interest);
    el('prev-total').textContent       = fmt(total);
    el('prev-installment').textContent = fmt(installment);
    el('prev-rate').textContent        = (rate * 100).toFixed(0) + '% / week';
    el('prev-duration').textContent    = duration + (duration === 1 ? ' week' : ' weeks');
    el('prev-early-saving').textContent = fmt(earlyDiscount);
    el('prev-early-amt').textContent   = fmt(earlyTotal);

    const submitBtn = el('form-submit-btn');
    if (submitBtn && !(currentPayload.activeLoansCount >= currentPayload.maxActiveLoans)) {
        submitBtn.disabled = amount <= 0;
    }
}

// ── Loan Submission ───────────────────────────
function submitLoan() {
    const data = {
        type:     el('loan-type').value,
        amount:   parseFloat(el('loan-amount').value),
        duration: parseInt(el('loan-duration').value),
        reason:   el('loan-reason').value
    };
    if (!data.amount || data.amount <= 0) return;

    fetch(`https://${getResource()}/applyLoan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(data)
    });

    el('loan-form').reset();
    updatePreview();
}

// ── Upcoming Dues Timeline ────────────────────
function renderUpcomingDues(loans) {
    const section   = el('upcoming-dues-section');
    const timeline  = el('dues-timeline');
    if (!section || !timeline) return;

    const now = Math.floor(Date.now() / 1000);
    const upcoming = [];

    loans.forEach(loan => {
        if (loan.status !== 1) return;
        (loan.dues || []).forEach(due => {
            if (!due.paid) {
                upcoming.push({
                    loanId: loan.id,
                    loanType: loan.type,
                    due: due.due,
                    amount: due.amount,
                    time: due.time,
                    convertedtime: due.convertedtime,
                    overdue: due.time && now > due.time,
                });
            }
        });
    });

    upcoming.sort((a, b) => a.time - b.time);

    if (upcoming.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';
    timeline.innerHTML = '';

    upcoming.slice(0, 6).forEach(item => {
        const daysLeft = Math.ceil((item.time - now) / 86400);
        const isOverdue = item.overdue;
        const urgency   = daysLeft <= 2 ? 'due-urgent' : daysLeft <= 5 ? 'due-soon' : '';

        const pill = document.createElement('div');
        pill.className = `due-pill ${isOverdue ? 'due-overdue' : urgency}`;
        pill.innerHTML = `
            <div class="due-pill-top">
                <span class="due-loan-chip">#${item.loanId}</span>
                <span class="due-badge">${isOverdue ? '⚠ OVERDUE' : daysLeft === 0 ? 'TODAY' : daysLeft < 0 ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}</span>
            </div>
            <div class="due-amount">${fmt(item.amount)}</div>
            <div class="due-date">${item.convertedtime || 'Unknown date'}</div>
            <div class="due-type">${item.loanType} — Instalment #${item.due}</div>`;
        timeline.appendChild(pill);
    });
}

// ── Score History ─────────────────────────────
function renderScoreHistory(history) {
    const list    = el('score-history-list');
    const countEl = el('score-history-count');
    if (!list) return;

    if (countEl) countEl.textContent = history.length + ' events';

    if (history.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                <p>No score events yet</p><span>Score changes will appear here</span>
            </div>`;
        return;
    }

    list.innerHTML = '';
    history.forEach((entry, i) => {
        const isPos  = entry.change > 0;
        const isNeg  = entry.change < 0;
        const date   = new Date(entry.time * 1000).toLocaleString();
        const row    = document.createElement('div');
        row.className = 'score-history-row';
        row.style.animationDelay = `${i * 30}ms`;
        row.innerHTML = `
            <div class="score-history-icon ${isPos ? 'shi-pos' : isNeg ? 'shi-neg' : 'shi-neutral'}">
                ${isPos ? '▲' : isNeg ? '▼' : '—'}
            </div>
            <div class="score-history-info">
                <span class="score-history-reason">${entry.reason || 'Unknown event'}</span>
                <span class="score-history-date">${date}</span>
            </div>
            <div class="score-history-right">
                <span class="score-delta ${isPos ? 'delta-pos' : isNeg ? 'delta-neg' : ''}">${isPos ? '+' : ''}${entry.change}</span>
                <span class="score-new">${entry.newScore} pts</span>
            </div>`;
        list.appendChild(row);
    });
}

// ── Sparkline Chart ───────────────────────────
function renderScoreSparkline(history) {
    const canvas = el('score-sparkline');
    if (!canvas || history.length < 2) return;

    canvas.width  = canvas.parentElement.clientWidth;
    const ctx     = canvas.getContext('2d');
    const pts     = [...history].reverse().map(h => h.newScore);
    const min     = Math.max(0, Math.min(...pts) - 50);
    const max     = Math.min(900, Math.max(...pts) + 50);
    const W       = canvas.width;
    const H       = canvas.height;
    const pad     = 10;

    function xPos(i)   { return pad + (i / (pts.length - 1)) * (W - pad * 2); }
    function yPos(val) { return H - pad - ((val - min) / (max - min)) * (H - pad * 2); }

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth   = 1;
    [0.25, 0.5, 0.75].forEach(frac => {
        const y = pad + frac * (H - pad * 2);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
    });

    // Gradient fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(0,232,122,0.3)');
    grad.addColorStop(1, 'rgba(0,232,122,0.0)');
    ctx.beginPath();
    ctx.moveTo(xPos(0), H - pad);
    pts.forEach((v, i) => ctx.lineTo(xPos(i), yPos(v)));
    ctx.lineTo(xPos(pts.length - 1), H - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.lineJoin   = 'round';
    ctx.lineCap    = 'round';
    ctx.lineWidth  = 2;
    ctx.strokeStyle = 'var(--green)';
    pts.forEach((v, i) => i === 0 ? ctx.moveTo(xPos(i), yPos(v)) : ctx.lineTo(xPos(i), yPos(v)));
    ctx.stroke();

    // Dots
    pts.forEach((v, i) => {
        ctx.beginPath();
        ctx.arc(xPos(i), yPos(v), 3, 0, Math.PI * 2);
        ctx.fillStyle = 'var(--green)';
        ctx.fill();
    });

    // Labels
    if (el('chart-min-label')) el('chart-min-label').textContent = Math.round(min);
    if (el('chart-max-label')) el('chart-max-label').textContent = Math.round(max);
}

// ── Loan Renderers ────────────────────────────
function renderMyLoans(loans) {
    const container = el('loans-container');
    const countEl   = el('loans-count');
    const emptyEl   = el('loans-empty');

    const filtered = loans.filter(l => l.status === 0 || l.status === 1 || l.status === 2);
    if (countEl) countEl.textContent = `${filtered.length} loan${filtered.length !== 1 ? 's' : ''}`;

    Array.from(container.children).forEach(c => { if (c !== emptyEl) c.remove(); });

    if (filtered.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    filtered.forEach((loan, i) => container.appendChild(buildLoanCard(loan, i * 50, false)));
}

function renderLoanHistory(loans) {
    const container = el('history-container');
    const paid = loans.filter(l => l.status === 3);
    container.innerHTML = '';
    if (paid.length === 0) {
        container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/></svg><p>No loan history yet</p><span>Paid loans will appear here</span></div>`;
        return;
    }
    paid.forEach((loan, i) => container.appendChild(buildLoanCard(loan, i * 50, false)));
}

// ── Loan Card Builder ─────────────────────────
function buildLoanCard(loan, delay, isBanker) {
    const div = document.createElement('div');
    const statusMap = {
        0: { cls: 's-pending',  badge: 's-badge-pending',  text: 'Pending'  },
        1: { cls: 's-active',   badge: 's-badge-active',   text: 'Active'   },
        2: { cls: 's-rejected', badge: 's-badge-rejected', text: 'Rejected' },
        3: { cls: 's-paid',     badge: 's-badge-paid',     text: 'Paid'     },
    };

    const s   = statusMap[loan.status] || statusMap[0];
    const amt = parseFloat(loan.amount)    || 0;
    const rem = parseFloat(loan.remaining) || 0;
    const pct = amt > 0 ? Math.round(((amt - rem) / amt) * 100) : 0;

    const progressColor = s.cls === 's-active'   ? 'var(--green)'
                        : s.cls === 's-overdue'   ? 'var(--red)'
                        : s.cls === 's-paid'      ? 'var(--text-muted)'
                        : 'var(--yellow)';

    div.className = `loan-card ${s.cls}`;
    div.style.animationDelay = `${delay}ms`;

    // Dues breakdown HTML (show all instalments)
    let duesHTML = '';
    if (loan.dues && loan.dues.length > 0) {
        const dueItems = loan.dues.map(d => {
            let cls = d.paid ? 'due-item-paid' : (d.overdue ? 'due-item-overdue' : 'due-item-upcoming');
            let icon = d.paid ? '✓' : (d.overdue ? '⚠' : '○');
            let tags = '';
            if (d.autoDeducted) tags += '<span class="due-tag tag-auto">auto</span>';
            if (d.defaulted)    tags += '<span class="due-tag tag-default">default</span>';
            if (d.deferred)     tags += '<span class="due-tag tag-defer">deferred</span>';
            if (d.earlyPayoff)  tags += '<span class="due-tag tag-early">early</span>';
            return `<div class="due-item ${cls}">
                <span class="due-icon">${icon}</span>
                <span class="due-num">#${d.due}</span>
                <span class="due-amt">${fmt(d.amount)}</span>
                <span class="due-dt">${d.convertedtime || '—'}</span>
                ${tags}
            </div>`;
        }).join('');

        duesHTML = `<div class="dues-breakdown" id="dues-${loan.id}" style="display:none;">
            <div class="dues-grid">${dueItems}</div>
        </div>
        <button class="dues-toggle-btn" onclick="toggleDues(${loan.id}, this)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            Show Instalments (${loan.dues.length})
        </button>`;
    }

    // Banker meta and actions
    let bankerMeta    = '';
    let bankerActions = '';

    if (isBanker) {
        const defaults  = loan.defaultCount  || 0;
        const deferrals = loan.deferralsUsed || 0;
        const riskLevel = defaults >= 2 ? 'risk-high' : defaults === 1 ? 'risk-med' : '';
        const riskLabel = defaults >= 2 ? '⚠ HIGH RISK' : defaults === 1 ? '△ MEDIUM RISK' : '';

        bankerMeta = `
            <div class="banker-loan-name">${loan.name || 'Unknown'}</div>
            <div class="banker-loan-meta">
                CitID: ${loan.citizenid || '—'}
                ${riskLabel ? `<span class="risk-chip ${riskLevel}">${riskLabel}</span>` : ''}
                ${defaults > 0 ? `<span class="risk-chip risk-med">Defaults: ${defaults}</span>` : ''}
                ${deferrals > 0 ? `<span class="risk-chip">Deferrals: ${deferrals}</span>` : ''}
            </div>`;

        bankerActions = `
            <div class="action-buttons">
                ${loan.status === 0 ? `
                    <button class="btn-approve" onclick="bankerAction('approve', ${loan.id})">✓ Approve</button>
                    <button class="btn-reject"  onclick="bankerAction('reject',  ${loan.id})">✗ Reject</button>
                ` : ''}
                ${loan.status === 1 ? `
                    <button class="btn-defer" onclick="bankerAction('defer', ${loan.id})">⏱ Defer Payment</button>
                ` : ''}
                ${(loan.status === 1 || loan.status === 3) ? `
                    <button class="btn-mail" onclick="bankerAction('mail', ${loan.id})">✉ Send Mail</button>
                ` : ''}
            </div>`;
    }

    // Player actions
    let playerActions = '';
    if (!isBanker && loan.status === 1 && rem > 0) {
        playerActions = `
            <div class="player-loan-actions">
                <button class="pay-btn" onclick="payLoan(${loan.id})">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Pay Now
                </button>
                ${earlyPayoffPct > 0 ? `
                <button class="early-pay-btn" onclick="earlyPayoff(${loan.id})" title="Pay full balance now at a discount">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Early Payoff (-${Math.round(earlyPayoffPct * 100)}%)
                </button>` : ''}
            </div>`;
    }

    div.innerHTML = `
        <div class="loan-card-row">
            <div class="loan-card-left">
                <div class="loan-title">
                    ${loan.type || 'Loan'}
                    <span class="loan-id-chip">#${loan.id}</span>
                </div>
                ${bankerMeta}
                <div class="loan-meta">
                    Amount: <span>${fmt(amt)}</span> &nbsp;|&nbsp;
                    Remaining: <span>${fmt(rem)}</span>
                </div>
                <div class="loan-progress-wrap">
                    <div class="loan-progress-label">
                        <span>Repaid ${pct}%</span>
                        <span>${fmt(amt - rem)} / ${fmt(amt)}</span>
                    </div>
                    <div class="loan-progress-track">
                        <div class="loan-progress-fill" style="width:${pct}%;background:${progressColor};"></div>
                    </div>
                </div>
                ${duesHTML}
                ${bankerActions}
                ${playerActions}
            </div>
            <div class="loan-card-right">
                <span class="loan-status ${s.badge}">${s.text}</span>
            </div>
        </div>`;

    return div;
}

function toggleDues(loanId, btn) {
    const panel = el(`dues-${loanId}`);
    if (!panel) return;
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : '';
    btn.innerHTML = open
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg> Show Instalments`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg> Hide Instalments`;
}

// ── Banker Panel ──────────────────────────────
function renderBankerLoans() {
    const container = el('banker-loans-container');
    const filter    = el('banker-filter').value;
    const search    = el('banker-search').value.toLowerCase();

    container.innerHTML = '';

    const filtered = allBankerLoans.filter(loan => {
        if (filter !== 'all' && loan.status.toString() !== filter) return false;
        if (search) {
            const cid  = (loan.citizenid || '').toLowerCase();
            const id   = loan.id.toString();
            const name = (loan.name || '').toLowerCase();
            if (!cid.includes(search) && !id.includes(search) && !name.includes(search)) return false;
        }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg><p>No matching loans</p><span>Adjust filters to see results</span></div>`;
        return;
    }

    filtered.forEach((loan, i) => container.appendChild(buildLoanCard(loan, i * 40, true)));
}

// ── Actions ───────────────────────────────────
function payLoan(id) {
    fetch(`https://${getResource()}/payLoanNUI`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
}

function earlyPayoff(id) {
    fetch(`https://${getResource()}/earlyPayoffNUI`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
}

function bankerAction(action, id) {
    const loan = allBankerLoans.find(l => l.id === id);
    if (!loan) return;
    fetch(`https://${getResource()}/bankerAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, loan })
    });
}

function closeUI() {
    fetch(`https://${getResource()}/closeUI`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
}

// ── Dev Preview ───────────────────────────────
if (window.location.protocol === 'file:' || !window.invokeNative) {
    const now = Math.floor(Date.now() / 1000);
    setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                action: 'open',
                payload: {
                    playerName:        'James Carter',
                    score:             720,
                    scoreHistory: [
                        { time: now - 3600,   change: +80,  reason: 'Loan fully paid off',         newScore: 720 },
                        { time: now - 86400,  change: -20,  reason: 'Hard inquiry — loan application', newScore: 640 },
                        { time: now - 172800, change: +200, reason: 'On-time payment',              newScore: 660 },
                        { time: now - 259200, change: -75,  reason: 'Late payment penalty',         newScore: 460 },
                        { time: now - 345600, change: +50,  reason: 'Perfect loan bonus',           newScore: 535 },
                        { time: now - 432000, change: +5,   reason: 'Passive credit recovery',      newScore: 485 },
                    ],
                    totalBorrowed:     25000,
                    totalOwed:         17500,
                    maxEligibility:    200000,
                    appCount:          3,
                    missedPayments:    1,
                    activeLoansCount:  2,
                    maxActiveLoans:    3,
                    earlyPayoffDiscount: 0.10,
                    maxDeferrals:      2,
                    isBanker:          false,
                    allLoans:          [],
                    loans: [
                        {
                            id: 1042, type: 'Personal Loan', amount: 10000, remaining: 6500, status: 1,
                            citizenid: 'QBK10001', loanDetails: '{}',
                            deferralsUsed: 1, defaultCount: 0,
                            dues: [
                                { due: 1, amount: 3334, paid: true,  time: now - 604800, convertedtime: 'Last week',    autoDeducted: false },
                                { due: 2, amount: 3333, paid: false, time: now + 86400,  convertedtime: 'Tomorrow',     overdue: false },
                                { due: 3, amount: 3333, paid: false, time: now + 691200, convertedtime: 'In 8 days',    overdue: false, deferred: true },
                            ]
                        },
                        {
                            id: 1031, type: 'Business Loan', amount: 15000, remaining: 11000, status: 1,
                            citizenid: 'QBK10001', loanDetails: '{}',
                            deferralsUsed: 0, defaultCount: 1,
                            dues: [
                                { due: 1, amount: 5000, paid: true,  time: now - 604800,  convertedtime: 'Last week', autoDeducted: true },
                                { due: 2, amount: 5000, paid: false, time: now - 86400,   convertedtime: 'Yesterday', overdue: true },
                                { due: 3, amount: 5000, paid: false, time: now + 518400,  convertedtime: 'In 6 days', overdue: false },
                            ]
                        },
                        { id: 1018, type: 'Home Loan', amount: 50000, remaining: 0, status: 3, dues: [], deferralsUsed: 0, defaultCount: 0 },
                    ]
                }
            }
        }));
    }, 300);
}
