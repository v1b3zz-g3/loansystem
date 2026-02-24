let allBankerLoans = [];

document.addEventListener('DOMContentLoaded', () => {
    // Tab Navigation
    const navBtns = document.querySelectorAll('.nav-btn');
    const tabs = document.querySelectorAll('.tab-content');

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            navBtns.forEach(b => b.classList.remove('active'));
            tabs.forEach(t => t.classList.remove('active'));
            
            btn.classList.add('active');
            document.getElementById(btn.dataset.target).classList.add('active');
        });
    });

    document.getElementById('btn-header-apply').addEventListener('click', () => {
        document.querySelector('[data-target="apply"]').click();
    });

    // Form Submission
    document.getElementById('loan-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const data = {
            type: document.getElementById('loan-type').value,
            amount: parseFloat(document.getElementById('loan-amount').value),
            duration: parseInt(document.getElementById('loan-duration').value),
            reason: document.getElementById('loan-reason').value
        };
        fetch(`https://${GetParentResourceName()}/applyLoan`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        document.getElementById('loan-form').reset();
    });

    // Banker Search & Filter
    document.getElementById('banker-search').addEventListener('input', renderBankerLoans);
    document.getElementById('banker-filter').addEventListener('change', renderBankerLoans);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeUI();
    });
});

window.addEventListener('message', (event) => {
    const data = event.data;
    if (data.action === 'open') {
        document.getElementById('app').classList.remove('hidden');
        updateDashboard(data.payload);
        
        // Handle Banker Tab Visibility
        const bankerNav = document.getElementById('nav-banker');
        if (data.payload.isBanker) {
            bankerNav.classList.remove('hidden');
            allBankerLoans = data.payload.allLoans;
            renderBankerLoans();
        } else {
            bankerNav.classList.add('hidden');
        }
        
        // Always reset to overview tab on open
        document.querySelector('[data-target="overview"]').click();
        
    } else if (data.action === 'close') {
        document.getElementById('app').classList.add('hidden');
    }
});

function closeUI() {
    fetch(`https://${GetParentResourceName()}/closeUI`, { method: 'POST', body: JSON.stringify({}) });
}

function updateDashboard(payload) {
    document.getElementById('welcome-text').innerText = `Welcome back, ${payload.playerName} 👋`;
    
    // Update Metrics
    document.getElementById('metric-credit-score').innerText = payload.score;
    const progress = document.getElementById('credit-progress');
    let scorePercent = (payload.score / 900) * 100;
    progress.style.width = `${scorePercent}%`;
    progress.style.backgroundColor = scorePercent < 40 ? 'var(--accent-red)' : (scorePercent < 70 ? '#f1c40f' : 'var(--accent-green)');

    document.getElementById('metric-active-loans').innerText = `$${payload.totalBorrowed.toLocaleString()}`;
    document.getElementById('metric-credit-line').innerText = `$${payload.maxEligibility.toLocaleString()}`;
    document.getElementById('metric-applications').innerText = payload.appCount;
    document.getElementById('metric-money-owed').innerText = `$${payload.totalOwed.toLocaleString()}`;
    document.getElementById('metric-missed').innerText = payload.missedPayments;
    
    if (payload.missedPayments > 0) {
        document.getElementById('metric-missed').style.color = 'var(--accent-red)';
    } else {
        document.getElementById('metric-missed').style.color = 'var(--accent-green)';
    }

    // Populate Active Loans (Personal)
    const container = document.getElementById('loans-container');
    container.innerHTML = '';
    payload.loans.forEach(loan => {
        const div = document.createElement('div');
        div.className = 'loan-item';
        
        let statusClass = 'status-active';
        let statusText = 'Active';
        if (loan.status === 3) { statusClass = 'status-paid'; statusText = 'Paid'; }
        if (loan.status === 0) { statusClass = 'status-paid'; statusText = 'Pending'; }
        if (loan.status === 2) { statusClass = 'status-overdue'; statusText = 'Rejected'; }

        div.innerHTML = `
            <div class="loan-info">
                <h4>Loan #${loan.id} - ${loan.type}</h4>
                <p>Remaining: $${loan.remaining} / $${loan.amount}</p>
            </div>
            <div style="text-align: right;">
                <span class="loan-status ${statusClass}">${statusText}</span>
                ${loan.remaining > 0 && loan.status === 1 ? `<br><button class="pay-btn" onclick="payLoan(${loan.id})">Pay Installment</button>` : ''}
            </div>
        `;
        container.appendChild(div);
    });
}

function renderBankerLoans() {
    const container = document.getElementById('banker-loans-container');
    const filter = document.getElementById('banker-filter').value;
    const search = document.getElementById('banker-search').value.toLowerCase();
    
    container.innerHTML = '';
    
    allBankerLoans.forEach(loan => {
        // Filter Logic
        if (filter !== 'all' && loan.status.toString() !== filter) return;
        if (search && !loan.citizenid.toLowerCase().includes(search) && !loan.id.toString().includes(search)) return;

        const div = document.createElement('div');
        div.className = 'loan-item';
        
        let statusClass = 'status-active';
        let statusText = 'Active';
        if (loan.status === 3) { statusClass = 'status-paid'; statusText = 'Paid'; }
        if (loan.status === 0) { statusClass = 'status-paid'; statusText = 'Pending'; }
        if (loan.status === 2) { statusClass = 'status-overdue'; statusText = 'Rejected'; }

        div.innerHTML = `
            <div class="loan-info">
                <h4>ID: #${loan.id} | CitID: ${loan.citizenid} | ${loan.name}</h4>
                <p>${loan.type} - Requested: $${loan.amount} | Remaining: $${loan.remaining}</p>
                <div class="action-buttons">
                    ${loan.status === 0 ? `
                        <button class="btn-approve" onclick="bankerAction('approve', ${loan.id})">Approve</button>
                        <button class="btn-reject" onclick="bankerAction('reject', ${loan.id})">Reject</button>
                    ` : ''}
                    ${(loan.status === 1 || loan.status === 3) ? `
                        <button class="btn-mail" onclick="bankerAction('mail', ${loan.id})">Send Mail</button>
                    ` : ''}
                </div>
            </div>
            <div style="text-align: right;">
                <span class="loan-status ${statusClass}">${statusText}</span>
            </div>
        `;
        container.appendChild(div);
    });
}

function payLoan(id) {
    fetch(`https://${GetParentResourceName()}/payLoanNUI`, { method: 'POST', body: JSON.stringify({ id: id }) });
}

function bankerAction(action, id) {
    const loan = allBankerLoans.find(l => l.id === id);
    if (!loan) return;
    
    fetch(`https://${GetParentResourceName()}/bankerAction`, { 
        method: 'POST', 
        body: JSON.stringify({ action: action, loan: loan }) 
    });
}