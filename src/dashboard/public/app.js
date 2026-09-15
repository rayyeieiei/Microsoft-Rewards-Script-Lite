(function () {
    'use strict';

    // Application State (In-Memory Only, Never Persisted)
    let currentAccounts = [];
    let currentSummary = null;
    let activeFilterStatus = 'all';
    let searchQuery = '';
    let sortBy = 'lastObserved';
    let lastFocusedElement = null;

    // Manual Action State (In-Memory Only)
    let csrfToken = null;
    let csrfTokenExpiresAt = 0;
    let currentManualRecords = [];
    let currentManualCursor = null;
    let nextManualCursor = null;
    let manualCursorHistory = [];
    let manualSearchQuery = '';
    let manualLifecycle = 'all';
    let manualVerification = 'all';
    let activeReportingRecord = null;

    // DOM Elements - Navigation Tabs
    const tabReadiness = document.getElementById('tab-readiness');
    const tabManual = document.getElementById('tab-manual');
    const viewReadiness = document.getElementById('view-readiness');
    const viewManual = document.getElementById('view-manual');

    // DOM Elements - Readiness Dashboard
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

    // DOM Elements - Manual Action Center
    const manualActionsTbody = document.getElementById('manual-actions-tbody');
    const manualEmptyState = document.getElementById('manual-empty-state');
    const manualSearchInput = document.getElementById('manual-search-input');
    const manualLifecycleFilter = document.getElementById('manual-lifecycle-filter');
    const manualVerificationFilter = document.getElementById('manual-verification-filter');
    const btnManualRefresh = document.getElementById('btn-manual-refresh');
    const btnManualPrev = document.getElementById('btn-manual-prev');
    const btnManualNext = document.getElementById('btn-manual-next');
    const manualPageInfo = document.getElementById('manual-page-info');

    // DOM Elements - Report Modal
    const reportModal = document.getElementById('report-modal');
    const reportModalTaskTitle = document.getElementById('report-modal-task-title');
    const reportNoteInput = document.getElementById('report-note-input');
    const btnCancelReport = document.getElementById('btn-cancel-report');
    const btnSubmitReport = document.getElementById('btn-submit-report');
    const btnCloseReportModal = document.getElementById('btn-close-report-modal');

    const STATUS_MAP = {
        'technically-ready-for-handoff': { label: 'Ready for Handoff', className: 'badge-teal' },
        'auth-required': { label: 'Auth Required', className: 'badge-blue' },
        'manual-review-required': { label: 'Manual Review', className: 'badge-purple' },
        'not-ready': { label: 'Not Ready', className: 'badge-amber' },
        'blocked': { label: 'Blocked', className: 'badge-red' },
        'unknown': { label: 'Unknown', className: 'badge-gray' }
    };

    const LIFECYCLE_MAP = {
        'available': { label: 'Available', className: 'badge-teal' },
        'in-progress': { label: 'In Progress', className: 'badge-blue' },
        'action-reported': { label: 'Action Reported', className: 'badge-purple' },
        'dismissed': { label: 'Dismissed', className: 'badge-gray' },
        'expired': { label: 'Expired', className: 'badge-red' }
    };

    const VERIFICATION_MAP = {
        'unverified': { label: 'Unverified', className: 'badge-amber' },
        'verification-pending': { label: 'Verification Pending', className: 'badge-blue' },
        'verified-complete': { label: 'Verified Complete', className: 'badge-teal' },
        'verification-failed': { label: 'Verification Failed', className: 'badge-red' }
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

    function createBadge(text, className) {
        const span = document.createElement('span');
        span.className = 'badge ' + className;
        span.textContent = text;
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
                const timeA = Date.parse(a.lastObservedAt) || 0;
                const timeB = Date.parse(b.lastObservedAt) || 0;
                return timeB - timeA;
            });
    }

    function renderTable() {
        while (accountsTbody.firstChild) {
            accountsTbody.removeChild(accountsTbody.firstChild);
        }

        const filtered = filterAndSortAccounts();

        if (filtered.length === 0) {
            emptyState.classList.remove('hidden');
        } else {
            emptyState.classList.add('hidden');
        }

        filtered.forEach(function (acc) {
            const tr = document.createElement('tr');

            const tdAcc = document.createElement('td');
            tdAcc.className = 'font-mono font-medium';
            tdAcc.textContent = acc.displayAccount || 'unknown';

            const tdStatus = document.createElement('td');
            tdStatus.appendChild(createStatusBadge(acc.status));

            const tdSession = document.createElement('td');
            tdSession.textContent = acc.sessionState || 'unknown';

            const tdTasks = document.createElement('td');
            tdTasks.textContent = String(acc.pendingTasksCount || 0);

            const tdPoints = document.createElement('td');
            tdPoints.className = 'font-bold';
            tdPoints.textContent = String(acc.advertisedPoints || 0);

            const tdObserved = document.createElement('td');
            tdObserved.className = 'text-muted';
            tdObserved.textContent = formatTime(acc.lastObservedAt);

            const tdAction = document.createElement('td');
            tdAction.textContent = acc.nextAction || '—';

            const tdDetails = document.createElement('td');
            const btnDetail = document.createElement('button');
            btnDetail.type = 'button';
            btnDetail.className = 'btn btn-secondary';
            btnDetail.textContent = 'View Details';
            btnDetail.setAttribute('aria-label', 'View details for ' + (acc.displayAccount || 'account'));
            btnDetail.addEventListener('click', function () {
                openModal(acc);
            });
            tdDetails.appendChild(btnDetail);

            tr.appendChild(tdAcc);
            tr.appendChild(tdStatus);
            tr.appendChild(tdSession);
            tr.appendChild(tdTasks);
            tr.appendChild(tdPoints);
            tr.appendChild(tdObserved);
            tr.appendChild(tdAction);
            tr.appendChild(tdDetails);

            accountsTbody.appendChild(tr);
        });

        announce('Accounts table updated. ' + filtered.length + ' accounts displayed.');
    }

    function formatTime(isoStr) {
        if (!isoStr) return '—';
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function openModal(acc) {
        lastFocusedElement = document.activeElement;
        modalTitle.textContent = acc.displayAccount || 'Account Details';

        while (modalBody.firstChild) {
            modalBody.removeChild(modalBody.firstChild);
        }

        const reasonsSection = document.createElement('div');
        const reasonsHeading = document.createElement('h3');
        reasonsHeading.className = 'modal-section-title';
        reasonsHeading.textContent = 'Technical Assessment Reasons';
        reasonsSection.appendChild(reasonsHeading);

        if (acc.reasons && acc.reasons.length > 0) {
            const ul = document.createElement('ul');
            ul.className = 'reason-list';
            acc.reasons.forEach(function (r) {
                const li = document.createElement('li');
                li.textContent = r;
                ul.appendChild(li);
            });
            reasonsSection.appendChild(ul);
        } else {
            const p = document.createElement('p');
            p.className = 'text-muted';
            p.textContent = 'No failure reasons recorded.';
            reasonsSection.appendChild(p);
        }
        modalBody.appendChild(reasonsSection);

        const tasksSection = document.createElement('div');
        const tasksHeading = document.createElement('h3');
        tasksHeading.className = 'modal-section-title';
        tasksHeading.textContent = 'Pending Task Handoffs';
        tasksSection.appendChild(tasksHeading);

        if (acc.pendingTasks && acc.pendingTasks.length > 0) {
            const ulTasks = document.createElement('ul');
            ulTasks.className = 'task-list';
            acc.pendingTasks.forEach(function (task) {
                const liTask = document.createElement('li');
                liTask.className = 'task-item';

                const titleSpan = document.createElement('span');
                titleSpan.className = 'task-title';
                titleSpan.textContent = task.title || task.taskKind || 'Task';

                const reasonBadge = document.createElement('span');
                reasonBadge.className = 'badge badge-purple';
                reasonBadge.textContent = task.reason || 'manual';

                liTask.appendChild(titleSpan);
                liTask.appendChild(reasonBadge);
                ulTasks.appendChild(liTask);
            });
            tasksSection.appendChild(ulTasks);
        } else {
            const p = document.createElement('p');
            p.className = 'text-muted';
            p.textContent = 'No pending task handoffs.';
            tasksSection.appendChild(p);
        }
        modalBody.appendChild(tasksSection);

        detailModal.classList.remove('hidden');
        btnModalDone.focus();
    }

    function closeModal() {
        detailModal.classList.add('hidden');
        if (lastFocusedElement) {
            lastFocusedElement.focus();
        }
    }

    // CSRF Session Token Management (Amendment 9)
    function fetchSessionToken() {
        return fetch('/api/session')
            .then(function (res) {
                if (!res.ok) throw new Error('Session token fetch failed');
                return res.json();
            })
            .then(function (data) {
                csrfToken = data.csrfToken;
                csrfTokenExpiresAt = Date.parse(data.expiresAt) || (Date.now() + 3500000);
                return csrfToken;
            })
            .catch(function (err) {
                console.warn('[DASHBOARD-SESSION] CSRF session fetch error:', err.message);
                return null;
            });
    }

    function getValidCsrfToken() {
        if (csrfToken && Date.now() < csrfTokenExpiresAt - 60000) {
            return Promise.resolve(csrfToken);
        }
        return fetchSessionToken();
    }

    // Manual Action Center Logic (Amendment 7, 8, 10)
    function fetchManualActions() {
        if (!manualActionsTbody) return;
        const params = new URLSearchParams();
        if (manualSearchQuery) params.append('search', manualSearchQuery);
        if (manualLifecycle !== 'all') params.append('lifecycleState', manualLifecycle);
        if (manualVerification !== 'all') params.append('verificationState', manualVerification);
        if (currentManualCursor) params.append('cursor', currentManualCursor);
        params.append('limit', '20');

        fetch('/api/manual-actions?' + params.toString())
            .then(function (res) {
                if (!res.ok) throw new Error('Failed to fetch manual actions');
                return res.json();
            })
            .then(function (data) {
                currentManualRecords = data.records || [];
                nextManualCursor = data.nextCursor || null;
                renderManualActionsTable(currentManualRecords, data.totalMatching || 0);
            })
            .catch(function (err) {
                console.warn('[DASHBOARD-MANUAL] Fetch error:', err.message);
            });
    }

    function renderManualActionsTable(records, totalMatching) {
        while (manualActionsTbody.firstChild) {
            manualActionsTbody.removeChild(manualActionsTbody.firstChild);
        }

        if (records.length === 0) {
            manualEmptyState.classList.remove('hidden');
        } else {
            manualEmptyState.classList.add('hidden');
        }

        records.forEach(function (rec) {
            const tr = document.createElement('tr');

            const tdAcc = document.createElement('td');
            tdAcc.className = 'font-mono font-medium';
            tdAcc.textContent = rec.displayAccount || 'unknown';

            const tdTitle = document.createElement('td');
            tdTitle.className = 'font-medium';
            tdTitle.textContent = rec.title;

            const tdKind = document.createElement('td');
            const kindBadge = document.createElement('span');
            kindBadge.className = 'badge badge-gray';
            kindBadge.textContent = rec.taskKind;
            tdKind.appendChild(kindBadge);

            const tdPoints = document.createElement('td');
            tdPoints.className = 'font-bold';
            tdPoints.textContent = rec.advertisedPoints != null ? rec.advertisedPoints + ' pts' : '—';

            const tdLifecycle = document.createElement('td');
            const lifeInfo = LIFECYCLE_MAP[rec.lifecycleState] || { label: rec.lifecycleState, className: 'badge-gray' };
            tdLifecycle.appendChild(createBadge(lifeInfo.label, lifeInfo.className));

            const tdVerification = document.createElement('td');
            const verInfo = VERIFICATION_MAP[rec.verificationState] || { label: rec.verificationState, className: 'badge-gray' };
            tdVerification.appendChild(createBadge(verInfo.label, verInfo.className));

            const tdObserved = document.createElement('td');
            tdObserved.className = 'text-muted';
            tdObserved.textContent = formatTime(rec.observedAt);

            const tdActions = document.createElement('td');

            if (rec.lifecycleState !== 'action-reported' && rec.lifecycleState !== 'dismissed') {
                const btnReport = document.createElement('button');
                btnReport.type = 'button';
                btnReport.className = 'btn-action-report';
                btnReport.textContent = 'Mark Reported';
                btnReport.setAttribute('aria-label', 'Report completion for ' + rec.title);
                btnReport.addEventListener('click', function () {
                    openReportModal(rec);
                });
                tdActions.appendChild(btnReport);
            }

            if (rec.lifecycleState !== 'dismissed') {
                const btnDismiss = document.createElement('button');
                btnDismiss.type = 'button';
                btnDismiss.className = 'btn-action-dismiss';
                btnDismiss.textContent = 'Dismiss';
                btnDismiss.setAttribute('aria-label', 'Dismiss ' + rec.title);
                btnDismiss.addEventListener('click', function () {
                    mutateAction(rec.recordId, 'dismiss', rec.revision);
                });
                tdActions.appendChild(btnDismiss);
            } else {
                const btnReopen = document.createElement('button');
                btnReopen.type = 'button';
                btnReopen.className = 'btn-action-reopen';
                btnReopen.textContent = 'Reopen';
                btnReopen.setAttribute('aria-label', 'Reopen ' + rec.title);
                btnReopen.addEventListener('click', function () {
                    mutateAction(rec.recordId, 'reopen', rec.revision);
                });
                tdActions.appendChild(btnReopen);
            }

            tr.appendChild(tdAcc);
            tr.appendChild(tdTitle);
            tr.appendChild(tdKind);
            tr.appendChild(tdPoints);
            tr.appendChild(tdLifecycle);
            tr.appendChild(tdVerification);
            tr.appendChild(tdObserved);
            tr.appendChild(tdActions);

            manualActionsTbody.appendChild(tr);
        });

        // Update pagination controls
        btnManualPrev.disabled = manualCursorHistory.length === 0;
        btnManualNext.disabled = !nextManualCursor;
        manualPageInfo.textContent = 'Total: ' + totalMatching + ' matching';
    }

    function mutateAction(recordId, action, expectedRevision, note) {
        getValidCsrfToken()
            .then(function (token) {
                return fetch('/api/manual-actions/' + encodeURIComponent(recordId) + '/' + action, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': token || ''
                    },
                    body: JSON.stringify({
                        expectedRevision: expectedRevision,
                        note: note || undefined
                    })
                });
            })
            .then(function (res) {
                if (res.status === 409) {
                    announce('Conflict: Task was modified concurrently. Refreshing.');
                    alert('Conflict: The task was modified concurrently by another process. The view will refresh.');
                    fetchManualActions();
                    return null;
                }
                if (res.status === 403) {
                    announce('CSRF session token expired. Renewing session.');
                    fetchSessionToken().then(function () {
                        fetchManualActions();
                    });
                    return null;
                }
                if (!res.ok) {
                    throw new Error('Action failed with status ' + res.status);
                }
                return res.json();
            })
            .then(function (data) {
                if (data && data.success) {
                    announce('Manual action updated successfully.');
                    fetchManualActions();
                }
            })
            .catch(function (err) {
                console.error('[DASHBOARD-MUTATE] Mutation error:', err.message);
            });
    }

    function openReportModal(rec) {
        activeReportingRecord = rec;
        reportModalTaskTitle.textContent = rec.title + ' (' + (rec.displayAccount || '') + ')';
        reportNoteInput.value = '';
        reportModal.classList.remove('hidden');
        reportNoteInput.focus();
    }

    function closeReportModal() {
        reportModal.classList.add('hidden');
        activeReportingRecord = null;
    }

    // Navigation Tab Switching
    function switchTab(targetTab) {
        if (targetTab === 'manual') {
            tabReadiness.classList.remove('active');
            tabReadiness.setAttribute('aria-selected', 'false');
            tabManual.classList.add('active');
            tabManual.setAttribute('aria-selected', 'true');
            viewReadiness.classList.add('hidden');
            viewManual.classList.remove('hidden');
            fetchManualActions();
        } else {
            tabManual.classList.remove('active');
            tabManual.setAttribute('aria-selected', 'false');
            tabReadiness.classList.add('active');
            tabReadiness.setAttribute('aria-selected', 'true');
            viewManual.classList.add('hidden');
            viewReadiness.classList.remove('hidden');
        }
    }

    // Event Listeners - Navigation
    if (tabReadiness) {
        tabReadiness.addEventListener('click', function () {
            switchTab('readiness');
        });
    }
    if (tabManual) {
        tabManual.addEventListener('click', function () {
            switchTab('manual');
        });
    }

    // Event Listeners - Technical Readiness
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
    detailModal.addEventListener('click', function (e) {
        if (e.target === detailModal) closeModal();
    });

    // Event Listeners - Manual Action Center
    if (manualSearchInput) {
        manualSearchInput.addEventListener('input', function (e) {
            manualSearchQuery = e.target.value.trim();
            currentManualCursor = null;
            manualCursorHistory = [];
            fetchManualActions();
        });
    }

    if (manualLifecycleFilter) {
        manualLifecycleFilter.addEventListener('change', function (e) {
            manualLifecycle = e.target.value;
            currentManualCursor = null;
            manualCursorHistory = [];
            fetchManualActions();
        });
    }

    if (manualVerificationFilter) {
        manualVerificationFilter.addEventListener('change', function (e) {
            manualVerification = e.target.value;
            currentManualCursor = null;
            manualCursorHistory = [];
            fetchManualActions();
        });
    }

    if (btnManualRefresh) {
        btnManualRefresh.addEventListener('click', function () {
            fetchManualActions();
        });
    }

    if (btnManualNext) {
        btnManualNext.addEventListener('click', function () {
            if (nextManualCursor) {
                manualCursorHistory.push(currentManualCursor);
                currentManualCursor = nextManualCursor;
                fetchManualActions();
            }
        });
    }

    if (btnManualPrev) {
        btnManualPrev.addEventListener('click', function () {
            if (manualCursorHistory.length > 0) {
                currentManualCursor = manualCursorHistory.pop() || null;
                fetchManualActions();
            }
        });
    }

    // Event Listeners - Report Modal
    if (btnCloseReportModal) btnCloseReportModal.addEventListener('click', closeReportModal);
    if (btnCancelReport) btnCancelReport.addEventListener('click', closeReportModal);
    if (reportModal) {
        reportModal.addEventListener('click', function (e) {
            if (e.target === reportModal) closeReportModal();
        });
    }

    if (btnSubmitReport) {
        btnSubmitReport.addEventListener('click', function () {
            if (!activeReportingRecord) return;
            const note = reportNoteInput.value.trim();
            const recId = activeReportingRecord.recordId;
            const rev = activeReportingRecord.revision;
            closeReportModal();
            mutateAction(recId, 'report', rev, note);
        });
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (!detailModal.classList.contains('hidden')) closeModal();
            if (reportModal && !reportModal.classList.contains('hidden')) closeReportModal();
        }
    });

    // Apply Real-Time / Polled Snapshot
    function applySnapshot(snapshot) {
        if (!snapshot) return;
        currentAccounts = snapshot.accounts || [];
        currentSummary = snapshot.summary || null;
        updateSummaryCards(currentSummary);
        renderTable();
    }

    // Fetch Status via HTTP (fallback and manual refresh)
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
    fetchSessionToken();
})();
