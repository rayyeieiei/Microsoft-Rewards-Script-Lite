(function () {
    'use strict';

    // Application State (In-Memory Only, Never Persisted)
    let currentAccounts = [];
    let currentSummary = null;
    let activeFilterStatus = 'all';
    let searchQuery = '';
    let sortBy = 'lastObserved';
    let lastFocusedElement = null;

    // DOM Elements
    const metricTotal = document.getElementById('metric-total');
    const metricReady = document.getElementById('metric-ready');
    const metricAuth = document.getElementById('metric-auth');
    const metricManual = document.getElementById('metric-manual');
    const metricNotReady = document.getElementById('metric-notready');
    const metricBlocked = document.getElementById('metric-blocked');

    const accountsTbody = document.getElementById('accounts-tbody');
    const emptyState = document.getElementById('empty-state');
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const sortBySelect = document.getElementById('sort-by');
    const btnRefresh = document.getElementById('btn-refresh');
    const sseIndicator = document.getElementById('sse-indicator');
    const liveAnnouncer = document.getElementById('live-announcer');

    const detailModal = document.getElementById('detail-modal');
    const modalTitle = document.getElementById('modal-account-title');
    const modalBody = document.getElementById('modal-body');
    const btnCloseModal = document.getElementById('btn-close-modal');
    const btnModalDone = document.getElementById('btn-modal-done');

    const STATUS_MAP = {
        'technically-ready-for-handoff': { label: 'Ready for Handoff', className: 'badge-teal' },
        'auth-required': { label: 'Auth Required', className: 'badge-blue' },
        'manual-review-required': { label: 'Manual Review', className: 'badge-purple' },
        'not-ready': { label: 'Not Ready', className: 'badge-amber' },
        'blocked': { label: 'Blocked', className: 'badge-red' },
        'unknown': { label: 'Unknown', className: 'badge-gray' }
    };

    function announce(message) {
        if (liveAnnouncer) {
            liveAnnouncer.textContent = message;
        }
    }

    function createStatusBadge(status) {
        const span = document.createElement('span');
        span.className = 'badge';
        const info = STATUS_MAP[status] || STATUS_MAP['unknown'];
        span.classList.add(info.className);
        span.textContent = info.label;
        return span;
    }

    function updateSummaryCards(summary) {
        if (!summary) return;
        metricTotal.textContent = String(summary.totalAccounts || 0);
        metricReady.textContent = String(summary.technicallyReadyForHandoff || 0);
        metricAuth.textContent = String(summary.authRequired || 0);
        metricManual.textContent = String(summary.manualReviewRequired || 0);
        metricNotReady.textContent = String(summary.notReady || 0);
        metricBlocked.textContent = String(summary.blocked || 0);
    }

    function filterAndSortAccounts() {
        return currentAccounts
            .filter(function (acc) {
                if (activeFilterStatus !== 'all' && acc.status !== activeFilterStatus) {
                    return false;
                }
                if (searchQuery) {
                    const query = searchQuery.toLowerCase();
                    const accName = (acc.displayAccount || '').toLowerCase();
                    if (!accName.includes(query)) return false;
                }
                return true;
            })
            .sort(function (a, b) {
                if (sortBy === 'displayAccount') {
                    return (a.displayAccount || '').localeCompare(b.displayAccount || '');
                }
                if (sortBy === 'status') {
                    return (a.status || '').localeCompare(b.status || '');
                }
                // default lastObserved descending
                const timeA = Date.parse(a.lastObservedAt) || 0;
                const timeB = Date.parse(b.lastObservedAt) || 0;
                return timeB - timeA;
            });
    }

    function renderTable() {
        // Clear tbody safely
        while (accountsTbody.firstChild) {
            accountsTbody.removeChild(accountsTbody.firstChild);
        }

        const filtered = filterAndSortAccounts();

        if (filtered.length === 0) {
            emptyState.classList.remove('hidden');
            return;
        }
        emptyState.classList.add('hidden');

        filtered.forEach(function (acc) {
            const tr = document.createElement('tr');

            // Account
            const tdAccount = document.createElement('td');
            const spanAcc = document.createElement('span');
            spanAcc.className = 'account-label';
            spanAcc.textContent = acc.displayAccount || 'unknown';
            tdAccount.appendChild(spanAcc);
            tr.appendChild(tdAccount);

            // Status
            const tdStatus = document.createElement('td');
            tdStatus.appendChild(createStatusBadge(acc.status));
            tr.appendChild(tdStatus);

            // Session
            const tdSession = document.createElement('td');
            tdSession.textContent = acc.sessionState || 'unknown';
            tr.appendChild(tdSession);

            // Pending Tasks
            const tdTasks = document.createElement('td');
            tdTasks.textContent = String(acc.pendingTaskCount || (acc.tasks ? acc.tasks.length : 0));
            tr.appendChild(tdTasks);

            // Advertised Points
            const tdPoints = document.createElement('td');
            if (typeof acc.advertisedPointsRemaining === 'number') {
                const spanPts = document.createElement('span');
                spanPts.textContent = String(acc.advertisedPointsRemaining);
                const small = document.createElement('small');
                small.className = 'points-tag';
                small.textContent = 'Advertised only';
                tdPoints.appendChild(spanPts);
                tdPoints.appendChild(small);
            } else {
                tdPoints.textContent = '—';
            }
            tr.appendChild(tdPoints);

            // Last Check
            const tdTime = document.createElement('td');
            try {
                const d = new Date(acc.lastObservedAt);
                tdTime.textContent = isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
            } catch (e) {
                tdTime.textContent = '—';
            }
            tr.appendChild(tdTime);

            // Next Action
            const tdAction = document.createElement('td');
            tdAction.textContent = acc.nextAction || '—';
            tr.appendChild(tdAction);

            // Details Button
            const tdDetails = document.createElement('td');
            const btnDetails = document.createElement('button');
            btnDetails.type = 'button';
            btnDetails.className = 'btn btn-secondary';
            btnDetails.textContent = 'Details';
            btnDetails.setAttribute('aria-label', 'View details for ' + acc.displayAccount);
            btnDetails.addEventListener('click', function () {
                lastFocusedElement = btnDetails;
                openModal(acc);
            });
            tdDetails.appendChild(btnDetails);
            tr.appendChild(tdDetails);

            accountsTbody.appendChild(tr);
        });
    }

    function openModal(acc) {
        modalTitle.textContent = acc.displayAccount || 'Account Details';

        // Clear previous content
        while (modalBody.firstChild) {
            modalBody.removeChild(modalBody.firstChild);
        }

        // Section: Technical Status
        const secStatus = document.createElement('div');
        secStatus.className = 'detail-item';
        const stTitle = document.createElement('div');
        stTitle.className = 'modal-section-title';
        stTitle.textContent = 'Technical Status';
        secStatus.appendChild(stTitle);
        secStatus.appendChild(createStatusBadge(acc.status));
        modalBody.appendChild(secStatus);

        // Section: Readiness Reasons
        if (acc.reasons && acc.reasons.length > 0) {
            const secReasons = document.createElement('div');
            secReasons.className = 'detail-item';
            const rTitle = document.createElement('div');
            rTitle.className = 'modal-section-title';
            rTitle.textContent = 'Readiness Reasons';
            secReasons.appendChild(rTitle);

            const ul = document.createElement('ul');
            ul.style.paddingLeft = '1.25rem';
            acc.reasons.forEach(function (r) {
                const li = document.createElement('li');
                li.textContent = r;
                ul.appendChild(li);
            });
            secReasons.appendChild(ul);
            modalBody.appendChild(secReasons);
        }

        // Section: Session State & Next Action
        const secOverview = document.createElement('div');
        secOverview.className = 'detail-item';
        const ovTitle = document.createElement('div');
        ovTitle.className = 'modal-section-title';
        ovTitle.textContent = 'Session & Action Plan';
        secOverview.appendChild(ovTitle);

        const pSession = document.createElement('p');
        pSession.textContent = 'Session State: ' + (acc.sessionState || 'unknown');
        secOverview.appendChild(pSession);

        const pNext = document.createElement('p');
        pNext.textContent = 'Next Action: ' + (acc.nextAction || '—');
        secOverview.appendChild(pNext);

        if (typeof acc.recentFailureCount === 'number') {
            const pFail = document.createElement('p');
            pFail.textContent = 'Recent Failures: ' + acc.recentFailureCount;
            secOverview.appendChild(pFail);
        }

        modalBody.appendChild(secOverview);

        // Section: Observed Tasks
        if (acc.tasks && acc.tasks.length > 0) {
            const secTasks = document.createElement('div');
            const tTitle = document.createElement('div');
            tTitle.className = 'modal-section-title';
            tTitle.textContent = 'Observed Tasks (' + acc.tasks.length + ')';
            secTasks.appendChild(tTitle);

            const ulTasks = document.createElement('ul');
            ulTasks.className = 'task-list';
            acc.tasks.forEach(function (task) {
                const li = document.createElement('li');
                li.className = 'task-card';

                const header = document.createElement('div');
                header.className = 'task-card-header';

                const strong = document.createElement('strong');
                strong.textContent = task.title || task.taskKind || 'Task';
                header.appendChild(strong);

                const outcomeBadge = document.createElement('span');
                outcomeBadge.className = 'badge badge-gray';
                outcomeBadge.textContent = task.outcome;
                header.appendChild(outcomeBadge);

                li.appendChild(header);

                const pReason = document.createElement('p');
                pReason.style.color = 'var(--text-secondary)';
                pReason.textContent = 'Reason: ' + (task.reason || '—');
                li.appendChild(pReason);

                if (typeof task.advertisedPoints === 'number') {
                    const pPts = document.createElement('p');
                    pPts.style.color = 'var(--primary)';
                    pPts.textContent = 'Advertised: +' + task.advertisedPoints + ' pts (Advertised only)';
                    li.appendChild(pPts);
                }

                ulTasks.appendChild(li);
            });
            secTasks.appendChild(ulTasks);
            modalBody.appendChild(secTasks);
        }

        detailModal.classList.remove('hidden');
        btnCloseModal.focus();
    }

    function closeModal() {
        detailModal.classList.add('hidden');
        if (lastFocusedElement) {
            lastFocusedElement.focus();
            lastFocusedElement = null;
        }
    }

    // Event Listeners
    searchInput.addEventListener('input', function (e) {
        searchQuery = e.target.value.trim();
        renderTable();
    });

    statusFilter.addEventListener('change', function (e) {
        activeFilterStatus = e.target.value;
        renderTable();
    });

    sortBySelect.addEventListener('change', function (e) {
        sortBy = e.target.value;
        renderTable();
    });

    btnRefresh.addEventListener('click', function () {
        fetchStatus();
    });

    btnCloseModal.addEventListener('click', closeModal);
    btnModalDone.addEventListener('click', closeModal);

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !detailModal.classList.contains('hidden')) {
            closeModal();
        }
    });

    // Close modal on click outside dialog
    detailModal.addEventListener('click', function (e) {
        if (e.target === detailModal) {
            closeModal();
        }
    });

    function applySnapshot(snapshot) {
        if (!snapshot) return;
        currentSummary = snapshot.summary;
        currentAccounts = snapshot.accounts || [];
        updateSummaryCards(currentSummary);
        renderTable();
        announce('Updated dashboard with ' + currentAccounts.length + ' accounts');
    }

    function fetchStatus() {
        btnRefresh.disabled = true;
        fetch('/api/status')
            .then(function (res) {
                if (!res.ok) throw new Error('Status fetch failed');
                return res.json();
            })
            .then(function (data) {
                applySnapshot(data);
            })
            .catch(function (err) {
                console.warn('[DASHBOARD] Local status fetch error:', err.message);
            })
            .finally(function () {
                btnRefresh.disabled = false;
            });
    }

    // Connect to SSE for Live Real-Time Updates
    function connectSse() {
        if (!window.EventSource) {
            fetchStatus();
            return;
        }

        try {
            const evtSource = new EventSource('/api/events');

            evtSource.addEventListener('snapshot', function (e) {
                try {
                    const data = JSON.parse(e.data);
                    applySnapshot(data);
                    if (sseIndicator) sseIndicator.classList.remove('disconnected');
                } catch (err) {
                    console.error('[DASHBOARD-SSE] Malformed event payload');
                }
            });

            evtSource.onerror = function () {
                if (sseIndicator) sseIndicator.classList.add('disconnected');
            };

            evtSource.onopen = function () {
                if (sseIndicator) sseIndicator.classList.remove('disconnected');
            };
        } catch (e) {
            console.warn('[DASHBOARD-SSE] Falling back to polling:', e);
            fetchStatus();
        }
    }

    // Initialization
    fetchStatus();
    connectSse();
})();
