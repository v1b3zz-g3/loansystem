/* ═══════════════════════════════════════════
   PACIFIC BANK — NUI CONTROLLER
   Handles: NUI messages, tab navigation,
   dashboard updates, loan form, banker panel
═══════════════════════════════════════════ */

'use strict';

// ── State ──────────────────────────────────
let allBankerLoans = [];
let currentPayload  = {};
let sessionStart    = Date.now();

// Interest rates per loan type (fallback visual)
const INTEREST_RATES = {
    'Personal Loan': 0.05,
    'Business Loan': 0.10,
    'Home Loan':     0.15
};

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
        sessionStart = Date.now();
        document.getElementById('app').classList.remove('hidden');
        currentPayload = payload;

        // Banker tab visibility
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

    // Loan form live preview
    ['loan-amount', 'loan-type', 'loan-duration'].forEach(id => {
        el(id)?.addEventListener('input', updatePreview);
        el(id)?.addEventListener('change', updatePreview);
    });

    // Loan form submit
    el('loan-form').addEventListener('submit', (e) => {
        e.preventDefault();
        submitLoan();
    });

    // Banker controls
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
}

// ── Dashboard Updater ─────────────────────────
function updateDashboard(p) {
    el('welcome-text').textContent = `Welcome back, ${p.playerName} 👋`;

    // Metrics
    el('metric-active-loans').textContent = fmt(p.totalBorrowed);
    el('metric-credit-line').textContent  = fmt(p.maxEligibility);
    el('metric-applications').textContent = fmtN(p.appCount);
    el('metric-money-owed').textContent   = fmt(p.totalOwed);

    // Missed payments coloring
    const missedEl = el('metric-missed');
    const missedSub = el('missed-sub');
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

    // Credit score (animated)
    animateCreditScore(p.score || 0);

    // Summary strip
    const acctStatus = el('account-status');
    const scoreCategory = el('score-category');
    const nextAction = el('next-action');

    if (p.missedPayments > 0) {
        acctStatus.textContent = 'PAYMENTS OVERDUE';
        acctStatus.className = 'summary-value status-bad';
    } else if (p.totalOwed > 0) {
        acctStatus.textContent = 'ACTIVE LOANS';
        acctStatus.className = 'summary-value accent-yellow';
    } else {
        acctStatus.textContent = 'GOOD STANDING';
        acctStatus.className = 'summary-value status-ok';
    }

    if (scoreCategory) {
        const { label } = getScoreInfo(p.score || 0);
        scoreCategory.textContent = label;
    }

    if (nextAction) {
        nextAction.textContent = p.totalOwed > 0 ? 'Make a payment' : 'Apply for a loan';
    }

    // Render loans
    renderMyLoans(p.loans || []);
    renderLoanHistory(p.loans || []);

    // Update preview defaults
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
    const start = performance.now();
    const duration = 1200;

    function step(now) {
        const t = Math.min((now - start) / duration, 1);
        // ease out expo
        const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
        current = Math.round(eased * targetScore);

        scoreEl.textContent = fmtN(current);

        const pct = (current / MAX_SCORE) * 100;
        progressEl.style.width = `${pct}%`;

        const { color, label } = getScoreInfo(current);
        progressEl.style.background = color;
        if (ratingEl) {
            ratingEl.textContent = label;
            ratingEl.style.color = color;
        }

        if (t < 1) scoreAnimFrame = requestAnimationFrame(step);
    }

    scoreAnimFrame = requestAnimationFrame(step);
}

function getScoreInfo(score) {
    if (score < 300)  return { color: 'var(--red)',    label: 'VERY POOR'  };
    if (score < 500)  return { color: '#ff6b35',       label: 'POOR'       };
    if (score < 650)  return { color: 'var(--yellow)', label: 'FAIR'       };
    if (score < 750)  return { color: '#7ecba1',       label: 'GOOD'       };
    return                   { color: 'var(--green)',  label: 'EXCELLENT'  };
}

// ── Repayment Preview ─────────────────────────
function updatePreview() {
    const amount   = parseFloat(el('loan-amount')?.value) || 0;
    const duration = parseInt(el('loan-duration')?.value)  || 1;
    const type     = el('loan-type')?.value || 'Personal Loan';
    const rate     = INTEREST_RATES[type] || 0.05;

    const interest   = amount * duration * rate;
    const total      = amount + interest;
    const installment = duration > 0 ? total / duration : total;

    el('prev-principal').textContent   = fmt(amount);
    el('prev-interest').textContent    = fmt(interest);
    el('prev-total').textContent       = fmt(total);
    el('prev-installment').textContent = fmt(installment);
    el('prev-rate').textContent        = (rate * 100).toFixed(0) + '% / week';
    el('prev-duration').textContent    = duration + (duration === 1 ? ' week' : ' weeks');

    const submitBtn = el('form-submit-btn');
    if (submitBtn) {
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });

    el('loan-form').reset();
    updatePreview();
}

// ── My Loans Renderer ─────────────────────────
function renderMyLoans(loans) {
    const container = el('loans-container');
    const countEl   = el('loans-count');
    const emptyEl   = el('loans-empty');

    // Only show active/pending
    const filtered = loans.filter(l => l.status === 0 || l.status === 1 || l.status === 2);

    if (countEl) countEl.textContent = `${filtered.length} loan${filtered.length !== 1 ? 's' : ''}`;

    // Clear non-empty-state children
    Array.from(container.children).forEach(c => {
        if (c !== emptyEl) c.remove();
    });

    if (filtered.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    filtered.forEach((loan, i) => {
        container.appendChild(buildLoanCard(loan, i * 50, false));
    });
}

// ── Loan History Renderer ─────────────────────
function renderLoanHistory(loans) {
    const container = el('history-container');
    const paid = loans.filter(l => l.status === 3);

    container.innerHTML = '';

    if (paid.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
                <p>No loan history yet</p>
                <span>Paid loans will appear here</span>
            </div>`;
        return;
    }

    paid.forEach((loan, i) => {
        container.appendChild(buildLoanCard(loan, i * 50, false));
    });
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

    const progressColor = s.cls === 's-active' ? 'var(--green)'
        : s.cls === 's-overdue' ? 'var(--red)'
        : s.cls === 's-paid'    ? 'var(--text-muted)'
        : 'var(--yellow)';

    div.className = `loan-card ${s.cls}`;
    div.style.animationDelay = `${delay}ms`;

    let bankerMeta = '';
    let bankerActions = '';

    if (isBanker) {
        bankerMeta = `
            <div class="banker-loan-name">${loan.name || 'Unknown'}</div>
            <div class="banker-loan-meta">CitID: ${loan.citizenid || '—'}</div>`;

        bankerActions = `
            <div class="action-buttons">
                ${loan.status === 0 ? `
                    <button class="btn-approve" onclick="bankerAction('approve', ${loan.id})">✓ Approve</button>
                    <button class="btn-reject" onclick="bankerAction('reject', ${loan.id})">✗ Reject</button>
                ` : ''}
                ${(loan.status === 1 || loan.status === 3) ? `
                    <button class="btn-mail" onclick="bankerAction('mail', ${loan.id})">✉ Send Mail</button>
                ` : ''}
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
                        <div class="loan-progress-fill" style="width: ${pct}%; background: ${progressColor};"></div>
                    </div>
                </div>
                ${bankerActions}
            </div>
            <div class="loan-card-right">
                <span class="loan-status ${s.badge}">${s.text}</span>
                ${loan.remaining > 0 && loan.status === 1 && !isBanker
                    ? `<button class="pay-btn" onclick="payLoan(${loan.id})">Pay Now</button>`
                    : ''}
            </div>
        </div>`;

    return div;
}

// ── Banker Panel Renderer ─────────────────────
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
        container.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <p>No matching loans</p>
                <span>Adjust filters to see results</span>
            </div>`;
        return;
    }

    filtered.forEach((loan, i) => {
        container.appendChild(buildLoanCard(loan, i * 40, true));
    });
}

// ── Actions ───────────────────────────────────
function payLoan(id) {
    fetch(`https://${getResource()}/payLoanNUI`, {
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

// ── Dev Preview Stub ──────────────────────────
// Remove this block in production — only for browser preview
if (window.location.protocol === 'file:' || !window.invokeNative) {
    setTimeout(() => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                action: 'open',
                payload: {
                    playerName:    'James Carter',
                    score:         720,
                    totalBorrowed: 25000,
                    totalOwed:     17500,
                    maxEligibility: 200000,
                    appCount:      3,
                    missedPayments: 0,
                    isBanker:      false,
                    allLoans:      [],
                    loans: [
                        { id: 1042, type: 'Personal Loan', amount: 10000, remaining: 6500, status: 1 },
                        { id: 1031, type: 'Business Loan', amount: 15000, remaining: 11000, status: 1 },
                        { id: 1018, type: 'Home Loan',     amount: 50000, remaining: 0,    status: 3 },
                    ]
                }
            }
        }));
    }, 300);
}
