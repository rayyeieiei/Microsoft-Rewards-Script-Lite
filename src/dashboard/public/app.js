;(function () {
    'use strict'

    // Application State (In-Memory Only, Never Persisted)
    let currentAccounts = []
    let currentSummary = null
    let currentDataSource = null
    let currentRuntime = null
    let currentMonitoring = null
    let currentBridgeDiagnostics = null
    let controlInFlight = false

    let currentRuntimeId = null
    let currentRuntimeStartTime = 0
    let currentRevision = -1
    let inFlightAbortController = null

    let activeFilterStatus = 'all'
    let searchQuery = ''
    let sortBy = 'lastObserved'
    let lastFocusedElement = null

    // Connection State
    let connectionState = 'connecting'
    let sseSource = null
    let fallbackPollTimer = null

    // Manual Action State (In-Memory Only)
    let csrfToken = null
    let csrfTokenExpiresAt = 0
    let currentManualRecords = []
    let currentManualCursor = null
    let nextManualCursor = null
    let manualCursorHistory = []
    let manualSearchQuery = ''
    let manualLifecycle = 'all'
    let manualVerification = 'all'
    let activeReportingRecord = null

    // DOM Elements - Navigation Tabs
    const tabReadiness = document.getElementById('tab-readiness')
    const tabManual = document.getElementById('tab-manual')
    const viewReadiness = document.getElementById('view-readiness')
    const viewManual = document.getElementById('view-manual')

    // DOM Elements - Status Badges & Indicators
    const runtimeStatusBadge = document.getElementById('runtime-status-badge')
    const monitoringStatusBadge = document.getElementById('monitoring-status-badge')
    const datasourceStatusBadge = document.getElementById('datasource-status-badge')
    const connectionStatusBadge = document.getElementById('connection-status-badge')
    const sseIndicator = document.getElementById('sse-indicator')
    const liveAnnouncer = document.getElementById('live-announcer')

    // DOM Elements - Mode & Timestamps
    const envModeBadge = document.getElementById('env-mode-badge')
    const dataSourceFile = document.getElementById('data-source-file')
    const timeLastChecked = document.getElementById('time-last-checked')
    const timeNextCheck = document.getElementById('time-next-check')
    const timeSnapshot = document.getElementById('time-snapshot')
    const checkingIndicator = document.getElementById('checking-indicator')
    const timeDataLoaded = document.getElementById('time-data-loaded')
    const metricRejected = document.getElementById('metric-rejected')
    const quickstartSourceFile = document.getElementById('quickstart-source-file')
    const bridgeStatusText = document.getElementById('bridge-status-text')
    const bridgeCounts = document.getElementById('bridge-counts')

    // DOM Elements - Guidance / Alert Banner
    const guidanceBanner = document.getElementById('guidance-banner')
    const alertTitle = document.getElementById('alert-title')
    const alertMessage = document.getElementById('alert-message')
    const alertRemediation = document.getElementById('alert-remediation')

    // DOM Elements - Summary Metric Cards
    const metricTotal = document.getElementById('metric-total')
    const metricReady = document.getElementById('metric-ready')
    const metricAuth = document.getElementById('metric-auth')
    const metricManual = document.getElementById('metric-manual')
    const metricNotReady = document.getElementById('metric-notready')
    const metricBlocked = document.getElementById('metric-blocked')

    // DOM Elements - Accounts Table & Controls
    const accountsTbody = document.getElementById('accounts-tbody')
    const emptyState = document.getElementById('empty-state')
    const emptyStateMessage = document.getElementById('empty-state-message')
    const btnResetFilter = document.getElementById('btn-reset-filter')
    const searchInput = document.getElementById('search-input')
    const statusFilter = document.getElementById('status-filter')
    const sortBySelect = document.getElementById('sort-by')
    const accountsCountInfo = document.getElementById('accounts-count-info')
    const btnRecheck = document.getElementById('btn-recheck')
    const btnToggleMonitoring = document.getElementById('btn-toggle-monitoring')
    const btnRefresh = document.getElementById('btn-refresh')

    // DOM Elements - Detail Modal
    const detailModal = document.getElementById('detail-modal')
    const modalTitle = document.getElementById('modal-account-title')
    const modalBody = document.getElementById('modal-body')
    const btnCloseModal = document.getElementById('btn-close-modal')
    const btnModalDone = document.getElementById('btn-modal-done')

    // DOM Elements - Manual Action Center
    const manualActionsTbody = document.getElementById('manual-actions-tbody')
    const manualEmptyState = document.getElementById('manual-empty-state')
    const manualSearchInput = document.getElementById('manual-search-input')
    const manualLifecycleFilter = document.getElementById('manual-lifecycle-filter')
    const manualVerificationFilter = document.getElementById('manual-verification-filter')
    const btnManualRefresh = document.getElementById('btn-manual-refresh')
    const btnManualPrev = document.getElementById('btn-manual-prev')
    const btnManualNext = document.getElementById('btn-manual-next')
    const manualPageInfo = document.getElementById('manual-page-info')

    // DOM Elements - Report Modal
    const reportModal = document.getElementById('report-modal')
    const reportModalTaskTitle = document.getElementById('report-modal-task-title')
    const reportNoteInput = document.getElementById('report-note-input')
    const btnCancelReport = document.getElementById('btn-cancel-report')
    const btnSubmitReport = document.getElementById('btn-submit-report')
    const btnCloseReportModal = document.getElementById('btn-close-report-modal')

    const STATUS_MAP = {
        'technically-ready-for-handoff': { label: 'Siap Handoff', className: 'badge-teal' },
        'technically-ready': { label: 'Siap Handoff', className: 'badge-teal' },
        'auth-required': { label: 'Perlu Autentikasi', className: 'badge-blue' },
        'manual-review-required': { label: 'Tindakan Manual', className: 'badge-purple' },
        'not-ready': { label: 'Belum Siap', className: 'badge-amber' },
        blocked: { label: 'Diblokir', className: 'badge-red' },
        'rate-limited': { label: 'Limit Sementara', className: 'badge-red' },
        'stale-evidence': { label: 'Bukti Usang', className: 'badge-gray' },
        'awaiting-verification': { label: 'Menunggu Verifikasi', className: 'badge-purple' },
        'present-unverified': { label: 'Sesi Belum Diverifikasi', className: 'badge-amber' },
        unknown: { label: 'Belum Dinilai', className: 'badge-gray' }
    }

    const LIFECYCLE_MAP = {
        available: { label: 'Tersedia', className: 'badge-teal' },
        'in-progress': { label: 'Diproses', className: 'badge-blue' },
        'action-reported': { label: 'Dilaporkan', className: 'badge-purple' },
        dismissed: { label: 'Dilewati', className: 'badge-gray' },
        expired: { label: 'Kedaluwarsa', className: 'badge-red' }
    }

    const VERIFICATION_MAP = {
        unverified: { label: 'Belum Terverifikasi', className: 'badge-amber' },
        'verification-pending': { label: 'Menunggu Verifikasi', className: 'badge-blue' },
        'verified-complete': { label: 'Terverifikasi Selesai', className: 'badge-teal' },
        'verification-failed': { label: 'Verifikasi Gagal', className: 'badge-red' }
    }

    function announce(message) {
        if (liveAnnouncer) {
            liveAnnouncer.textContent = message
        }
    }

    function createStatusBadge(status) {
        const span = document.createElement('span')
        span.className = 'badge'
        const info = STATUS_MAP[status] || STATUS_MAP['unknown']
        span.classList.add(info.className)
        span.textContent = info.label
        return span
    }

    function createBadge(text, className) {
        const span = document.createElement('span')
        span.className = 'badge ' + className
        span.textContent = text
        return span
    }

    function formatTime(isoStr) {
        if (!isoStr) return '—'
        const d = new Date(isoStr)
        if (isNaN(d.getTime())) return '—'
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    function updateHeaderStatus() {
        // 0. Mode & Source File
        if (envModeBadge && currentDataSource) {
            const mode =
                currentDataSource.environmentMode || (currentRuntime && currentRuntime.environmentMode) || 'normal'
            if (mode === 'development') {
                envModeBadge.className = 'badge badge-purple'
                envModeBadge.textContent = 'Mode: Development'
            } else {
                envModeBadge.className = 'badge badge-teal'
                envModeBadge.textContent = 'Mode: Normal'
            }
        }
        if (dataSourceFile && currentDataSource && currentDataSource.sourceFile) {
            dataSourceFile.textContent = currentDataSource.sourceFile
        }

        // 1. Runtime Status
        if (runtimeStatusBadge) {
            runtimeStatusBadge.className = 'badge'
            const rState = currentRuntime ? currentRuntime.status : 'starting'
            if (rState === 'running') {
                runtimeStatusBadge.classList.add('badge-teal')
                runtimeStatusBadge.textContent = 'Observer: Berjalan'
            } else if (rState === 'degraded') {
                runtimeStatusBadge.classList.add('badge-amber')
                runtimeStatusBadge.textContent = 'Observer: Terdegradasi'
            } else if (rState === 'stopping') {
                runtimeStatusBadge.classList.add('badge-red')
                runtimeStatusBadge.textContent = 'Observer: Berhenti...'
            } else {
                runtimeStatusBadge.classList.add('badge-amber')
                runtimeStatusBadge.textContent = 'Observer: Memulai...'
            }
        }

        // 2. Data Source Status
        if (datasourceStatusBadge) {
            datasourceStatusBadge.className = 'badge'
            const dState = currentDataSource ? currentDataSource.status : 'loading'
            const file = currentDataSource ? currentDataSource.sourceFile : 'accounts.json'
            if (dState === 'loaded') {
                datasourceStatusBadge.classList.add('badge-teal')
                datasourceStatusBadge.textContent =
                    'Akun: ' + file + ' (' + (currentDataSource.acceptedCount || 0) + ' Terbaca)'
            } else if (dState === 'empty') {
                datasourceStatusBadge.classList.add('badge-amber')
                datasourceStatusBadge.textContent = 'Akun: ' + file + ' (Kosong)'
            } else if (dState === 'failed') {
                datasourceStatusBadge.classList.add('badge-red')
                datasourceStatusBadge.textContent = 'Akun: ' + file + ' (Gagal)'
            } else {
                datasourceStatusBadge.classList.add('badge-blue')
                datasourceStatusBadge.textContent = 'Akun: Membaca...'
            }
        }

        // 3. Rejection counter badge
        if (metricRejected) {
            const rejections = currentDataSource ? currentDataSource.rejectedCount || 0 : 0
            if (rejections > 0) {
                metricRejected.classList.remove('hidden')
                metricRejected.textContent = rejections + ' Ditolak'
            } else {
                metricRejected.classList.add('hidden')
            }
        }

        // 4. Connection Status
        if (connectionStatusBadge) {
            connectionStatusBadge.className = 'badge'
            if (connectionState === 'connected') {
                connectionStatusBadge.classList.add('badge-teal')
                connectionStatusBadge.textContent = 'Koneksi: Terhubung (Live)'
                if (sseIndicator) sseIndicator.classList.remove('disconnected')
            } else if (connectionState === 'reconnecting') {
                connectionStatusBadge.classList.add('badge-amber')
                connectionStatusBadge.textContent = 'Koneksi: Menghubungkan Ulang...'
                if (sseIndicator) sseIndicator.classList.add('disconnected')
            } else if (connectionState === 'disconnected') {
                connectionStatusBadge.classList.add('badge-red')
                connectionStatusBadge.textContent = 'Koneksi: Terputus'
                if (sseIndicator) sseIndicator.classList.add('disconnected')
            } else {
                connectionStatusBadge.classList.add('badge-gray')
                connectionStatusBadge.textContent = 'Koneksi: Menghubungkan...'
                if (sseIndicator) sseIndicator.classList.remove('disconnected')
            }
        }

        // 5. Monitoring Status Badge
        if (monitoringStatusBadge) {
            monitoringStatusBadge.className = 'badge'
            if (currentMonitoring && currentMonitoring.pendingPause) {
                monitoringStatusBadge.classList.add('badge-amber')
                monitoringStatusBadge.textContent = 'Pemantauan: Menjeda...'
            } else if (currentMonitoring && currentMonitoring.monitoringState === 'paused') {
                monitoringStatusBadge.classList.add('badge-gray')
                monitoringStatusBadge.textContent = 'Pemantauan: Dijeda'
            } else {
                monitoringStatusBadge.classList.add('badge-teal')
                monitoringStatusBadge.textContent = 'Pemantauan: Berjalan'
            }
        }

        // 6. Checking Indicator & Timestamps
        const isChecking = Boolean(currentMonitoring && currentMonitoring.checkingState === 'checking')
        const isPendingPause = Boolean(currentMonitoring && currentMonitoring.pendingPause)
        const isPaused = Boolean(currentMonitoring && currentMonitoring.monitoringState === 'paused')

        if (checkingIndicator) {
            if (isChecking) {
                checkingIndicator.className = 'badge badge-amber'
                checkingIndicator.textContent = 'Memeriksa data lokal...'
                checkingIndicator.classList.remove('hidden')
            } else if (currentMonitoring && currentMonitoring.checkingState === 'failed') {
                checkingIndicator.className = 'badge badge-red'
                const errorMsg = currentMonitoring.lastResultSummary && currentMonitoring.lastResultSummary.errorMessage
                checkingIndicator.textContent = errorMsg ? 'Gagal: ' + errorMsg : 'Pemeriksaan gagal'
                checkingIndicator.classList.remove('hidden')
            } else {
                checkingIndicator.classList.add('hidden')
            }
        }

        if (timeLastChecked) {
            if (currentMonitoring && currentMonitoring.lastCheckedAt) {
                let txt = formatTime(currentMonitoring.lastCheckedAt)
                if (
                    currentMonitoring.lastResultSummary &&
                    currentMonitoring.lastResultSummary.accountsChecked !== undefined
                ) {
                    txt += ' (' + currentMonitoring.lastResultSummary.accountsChecked + ' akun)'
                }
                timeLastChecked.textContent = txt
            } else {
                timeLastChecked.textContent = '—'
            }
        }

        if (timeNextCheck) {
            if (isPaused) {
                timeNextCheck.textContent = 'Dijeda'
            } else if (isPendingPause) {
                timeNextCheck.textContent = 'Menjeda...'
            } else if (currentMonitoring && currentMonitoring.nextCheckAt) {
                timeNextCheck.textContent = formatTime(currentMonitoring.nextCheckAt)
            } else {
                timeNextCheck.textContent = '—'
            }
        }

        if (quickstartSourceFile && currentDataSource && currentDataSource.sourceFile) {
            quickstartSourceFile.textContent = currentDataSource.sourceFile
        }

        if (bridgeStatusText && bridgeCounts) {
            if (currentBridgeDiagnostics && currentBridgeDiagnostics.status === 'active') {
                bridgeStatusText.textContent = 'Aktif (' + (currentBridgeDiagnostics.activeDirectory || 'bridge') + ')'
                bridgeCounts.textContent =
                    (currentBridgeDiagnostics.processedCount || 0) + ' diproses, ' +
                    (currentBridgeDiagnostics.rejectedCount || 0) + ' ditolak'
            } else {
                bridgeStatusText.textContent = 'Nonaktif / Belum Terhubung'
                bridgeCounts.textContent = '0 file'
            }
        }

        // 7. Operational Buttons State (Rule 1: Only disable btnRecheck during checking)
        if (btnRecheck) {
            btnRecheck.disabled = isChecking || controlInFlight
            if (isChecking) {
                btnRecheck.textContent = 'Memeriksa Data Lokal...'
            } else {
                btnRecheck.textContent = 'Periksa Ulang Akun'
            }
        }

        if (btnToggleMonitoring) {
            btnToggleMonitoring.disabled = controlInFlight
            if (isPendingPause) {
                btnToggleMonitoring.className = 'btn btn-secondary'
                btnToggleMonitoring.textContent = 'Menjeda setelah pemeriksaan selesai'
                btnToggleMonitoring.title = 'Pemeriksaan aktif sedang berjalan; pemantauan akan dijeda begitu selesai'
            } else if (isPaused) {
                btnToggleMonitoring.className = 'btn btn-primary'
                btnToggleMonitoring.textContent = 'Lanjutkan Pemantauan'
                btnToggleMonitoring.title = 'Mengaktifkan kembali penjadwalan pemantauan berkala'
            } else {
                btnToggleMonitoring.className = 'btn btn-secondary'
                btnToggleMonitoring.textContent = 'Jeda Pemantauan'
                btnToggleMonitoring.title = 'Menghentikan penjadwalan pemantauan berkala berikutnya'
            }
        }
    }

    function updateGuidanceBanner() {
        if (!guidanceBanner) return

        // Priority 1: Connection Disconnected Alert
        if (connectionState === 'disconnected' || connectionState === 'reconnecting') {
            guidanceBanner.className = 'alert-banner alert-error'
            guidanceBanner.classList.remove('hidden')
            alertTitle.textContent = 'Koneksi Dashboard Terputus'
            alertMessage.textContent =
                'Koneksi dashboard terputus. Data terakhir mungkin belum terbaru. Mencoba menghubungkan ulang secara berkala...'
            alertRemediation.classList.add('hidden')
            return
        }

        // Priority 2: Data Source Failed Alert
        if (currentDataSource && currentDataSource.status === 'failed') {
            guidanceBanner.className = 'alert-banner alert-error'
            guidanceBanner.classList.remove('hidden')
            const err = currentDataSource.error
            const code = err ? err.code : 'error'
            alertTitle.textContent = 'Sumber Akun Gagal Dimuat (' + code + ')'
            alertMessage.textContent = err ? err.message : 'Gagal memuat konfigurasi akun observer.'

            if (err && err.remediation) {
                alertRemediation.classList.remove('hidden')
                alertRemediation.textContent = err.remediation
            } else {
                alertRemediation.classList.add('hidden')
            }
            return
        }

        // Priority 3: Data Source Empty Alert
        if (currentDataSource && currentDataSource.status === 'empty') {
            guidanceBanner.className = 'alert-banner alert-info'
            guidanceBanner.classList.remove('hidden')
            alertTitle.textContent = 'Sumber Akun Kosong'
            alertMessage.textContent =
                'Belum ada akun yang dikonfigurasi di file ' + (currentDataSource.sourceFile || 'accounts.json') + '.'
            alertRemediation.classList.remove('hidden')
            alertRemediation.textContent =
                'Tambahkan entri akun ke file ' +
                (currentDataSource.sourceFile || 'accounts.json') +
                ' sesuai format JSON array.'
            return
        }

        // Priority 4: Rejections Warning Banner
        if (currentDataSource && currentDataSource.rejectedCount > 0 && currentDataSource.status === 'loaded') {
            guidanceBanner.className = 'alert-banner alert-warning'
            guidanceBanner.classList.remove('hidden')
            alertTitle.textContent =
                currentDataSource.rejectedCount + ' Akun Ditolak dari ' + currentDataSource.sourceFile
            alertMessage.textContent =
                'Beberapa entri akun tidak dapat dimuat: ' + (currentDataSource.rejectionReasons || []).join('; ')
            alertRemediation.classList.remove('hidden')
            alertRemediation.textContent =
                'Periksa file ' +
                currentDataSource.sourceFile +
                ' dan pastikan setiap akun memiliki alamat email yang valid dan tidak duplikat.'
            return
        }

        // Normal state: Hide guidance banner
        guidanceBanner.classList.add('hidden')
    }

    function updateSummaryCards(summary) {
        if (!summary) return
        metricTotal.textContent = String(summary.totalAccounts || 0)
        metricReady.textContent = String(summary.technicallyReadyForHandoff || 0)
        metricAuth.textContent = String(summary.authRequired || 0)
        metricManual.textContent = String(summary.manualReviewRequired || 0)
        metricNotReady.textContent = String((summary.notReady || 0) + (summary.unknown || 0))
        metricBlocked.textContent = String(summary.blocked || 0)
    }

    function filterAndSortAccounts() {
        return currentAccounts
            .filter(function (acc) {
                if (activeFilterStatus !== 'all' && acc.status !== activeFilterStatus) {
                    return false
                }
                if (searchQuery) {
                    const query = searchQuery.toLowerCase()
                    const accName = (acc.displayAccount || '').toLowerCase()
                    if (!accName.includes(query)) return false
                }
                return true
            })
            .sort(function (a, b) {
                if (sortBy === 'displayAccount') {
                    return (a.displayAccount || '').localeCompare(b.displayAccount || '')
                }
                if (sortBy === 'status') {
                    return (a.status || '').localeCompare(b.status || '')
                }
                const timeA = Date.parse(a.lastObservedAt) || 0
                const timeB = Date.parse(b.lastObservedAt) || 0
                return timeB - timeA
            })
    }

    function renderTable() {
        while (accountsTbody.firstChild) {
            accountsTbody.removeChild(accountsTbody.firstChild)
        }

        const filtered = filterAndSortAccounts()

        // Update count info
        if (accountsCountInfo) {
            accountsCountInfo.textContent =
                'Menampilkan ' + filtered.length + ' dari ' + currentAccounts.length + ' akun'
        }

        if (filtered.length === 0) {
            emptyState.classList.remove('hidden')

            if (currentAccounts.length > 0) {
                // Filter produced 0 results
                emptyStateMessage.textContent = 'Tidak ada akun yang cocok dengan filter yang dipilih.'
                if (btnResetFilter) btnResetFilter.classList.remove('hidden')
            } else if (currentDataSource && currentDataSource.status === 'failed') {
                emptyStateMessage.textContent = 'Sumber akun belum ditemukan atau gagal dimuat. Periksa konfigurasi.'
                if (btnResetFilter) btnResetFilter.classList.add('hidden')
            } else if (currentDataSource && currentDataSource.status === 'empty') {
                emptyStateMessage.textContent = 'Belum ada akun yang dikonfigurasi.'
                if (btnResetFilter) btnResetFilter.classList.add('hidden')
            } else {
                emptyStateMessage.textContent = 'Sedang membaca data akun atau menunggu data pertama dari observer...'
                if (btnResetFilter) btnResetFilter.classList.add('hidden')
            }
        } else {
            emptyState.classList.add('hidden')
            if (btnResetFilter) btnResetFilter.classList.add('hidden')
        }

        filtered.forEach(function (acc) {
            const tr = document.createElement('tr')

            const tdAcc = document.createElement('td')
            tdAcc.className = 'font-mono font-medium'
            tdAcc.textContent = acc.displayAccount || 'unknown'

            const tdStatus = document.createElement('td')
            tdStatus.appendChild(createStatusBadge(acc.status))

            const tdSession = document.createElement('td')
            tdSession.textContent = acc.sessionState || 'unknown'

            const tdEvidence = document.createElement('td')
            const evBadge = document.createElement('span')
            evBadge.className = 'badge'
            if (acc.evidenceState === 'present') {
                evBadge.classList.add('badge-teal')
                evBadge.textContent = 'Ada Bukti Server'
            } else if (acc.evidenceState === 'stale') {
                evBadge.classList.add('badge-amber')
                evBadge.textContent = 'Bukti Usang'
            } else {
                evBadge.classList.add('badge-gray')
                evBadge.textContent = 'Belum Ada'
            }
            tdEvidence.appendChild(evBadge)

            const tdTasks = document.createElement('td')
            tdTasks.textContent = String(acc.pendingTaskCount || 0)

            const tdPoints = document.createElement('td')
            tdPoints.className = 'font-bold'
            tdPoints.textContent =
                acc.advertisedPointsRemaining != null ? String(acc.advertisedPointsRemaining) + ' pts' : '—'

            const tdObserved = document.createElement('td')
            tdObserved.className = 'text-muted'
            tdObserved.textContent = formatTime(acc.lastObservedAt)

            const tdAction = document.createElement('td')
            tdAction.textContent = acc.nextAction || '—'

            const tdDetails = document.createElement('td')
            const btnDetail = document.createElement('button')
            btnDetail.type = 'button'
            btnDetail.className = 'btn btn-secondary'
            btnDetail.textContent = 'Lihat Detail'
            btnDetail.setAttribute('aria-label', 'Lihat detail untuk ' + (acc.displayAccount || 'akun'))
            btnDetail.addEventListener('click', function () {
                openModal(acc)
            })
            tdDetails.appendChild(btnDetail)

            tr.appendChild(tdAcc)
            tr.appendChild(tdStatus)
            tr.appendChild(tdSession)
            tr.appendChild(tdEvidence)
            tr.appendChild(tdTasks)
            tr.appendChild(tdPoints)
            tr.appendChild(tdObserved)
            tr.appendChild(tdAction)
            tr.appendChild(tdDetails)

            accountsTbody.appendChild(tr)
        })

        announce('Tabel akun diperbarui. ' + filtered.length + ' akun ditampilkan.')
    }

    function openModal(acc) {
        lastFocusedElement = document.activeElement
        modalTitle.textContent = acc.displayAccount || 'Detail Akun'

        while (modalBody.firstChild) {
            modalBody.removeChild(modalBody.firstChild)
        }

        const metaSection = document.createElement('div')
        metaSection.className = 'modal-meta-grid'
        metaSection.style.marginBottom = '1rem'
        metaSection.style.padding = '0.75rem'
        metaSection.style.background = 'var(--bg-secondary, #f8fafc)'
        metaSection.style.borderRadius = '6px'
        metaSection.style.fontSize = '0.875rem'

        function addMetaRow(label, value) {
            const p = document.createElement('p')
            p.style.margin = '0.25rem 0'
            const strong = document.createElement('strong')
            strong.textContent = label + ': '
            p.appendChild(strong)
            p.appendChild(document.createTextNode(value))
            metaSection.appendChild(p)
        }

        addMetaRow('Status Sesi Lokal', acc.sessionState || 'unknown')
        addMetaRow(
            'Bukti Observasi Server',
            acc.evidenceState === 'present'
                ? 'Tersedia'
                : acc.evidenceState === 'stale'
                  ? 'Kedaluwarsa (Stale)'
                  : 'Belum Terhubung'
        )
        addMetaRow(
            'Waktu Observasi Server',
            acc.evidenceObservedAt ? formatTime(acc.evidenceObservedAt) : 'Belum pernah diobservasi server'
        )
        addMetaRow('Pemeriksaan Lokal', formatTime(acc.lastObservedAt))
        modalBody.appendChild(metaSection)

        const reasonsSection = document.createElement('div')
        const reasonsHeading = document.createElement('h3')
        reasonsHeading.className = 'modal-section-title'
        reasonsHeading.textContent = 'Alasan Penilaian Kesiapan Teknis'
        reasonsSection.appendChild(reasonsHeading)

        if (acc.reasons && acc.reasons.length > 0) {
            const ul = document.createElement('ul')
            ul.className = 'reason-list'
            acc.reasons.forEach(function (r) {
                const li = document.createElement('li')
                li.textContent = r
                ul.appendChild(li)
            })
            reasonsSection.appendChild(ul)
        } else {
            const p = document.createElement('p')
            p.className = 'text-muted'
            p.textContent = 'Tidak ada alasan kegagalan tercatat.'
            reasonsSection.appendChild(p)
        }
        modalBody.appendChild(reasonsSection)

        const tasksSection = document.createElement('div')
        const tasksHeading = document.createElement('h3')
        tasksHeading.className = 'modal-section-title'
        tasksHeading.textContent = 'Task Handoff Tertunda'
        tasksSection.appendChild(tasksHeading)

        if (acc.tasks && acc.tasks.length > 0) {
            const ulTasks = document.createElement('ul')
            ulTasks.className = 'task-list'
            acc.tasks.forEach(function (task) {
                const liTask = document.createElement('li')
                liTask.className = 'task-item'

                const titleSpan = document.createElement('span')
                titleSpan.className = 'task-title'
                titleSpan.textContent = task.title || task.taskKind || 'Task'

                const reasonBadge = document.createElement('span')
                reasonBadge.className = 'badge badge-purple'
                reasonBadge.textContent = task.reason || 'manual'

                liTask.appendChild(titleSpan)
                liTask.appendChild(reasonBadge)
                ulTasks.appendChild(liTask)
            })
            tasksSection.appendChild(ulTasks)
        } else {
            const p = document.createElement('p')
            p.className = 'text-muted'
            p.textContent = 'Tidak ada task handoff tertunda.'
            tasksSection.appendChild(p)
        }
        modalBody.appendChild(tasksSection)

        detailModal.classList.remove('hidden')
        btnModalDone.focus()
    }

    function closeModal() {
        detailModal.classList.add('hidden')
        if (lastFocusedElement) {
            lastFocusedElement.focus()
        }
    }

    // CSRF Session Token Management
    function fetchSessionToken() {
        return fetch('/api/session')
            .then(function (res) {
                if (!res.ok) throw new Error('Pengambilan token sesi gagal')
                return res.json()
            })
            .then(function (data) {
                csrfToken = data.csrfToken
                csrfTokenExpiresAt = Date.parse(data.expiresAt) || Date.now() + 3500000
                return csrfToken
            })
            .catch(function (err) {
                console.warn('[DASHBOARD-SESSION] CSRF error:', err.message)
                return null
            })
    }

    function getValidCsrfToken() {
        if (csrfToken && Date.now() < csrfTokenExpiresAt - 60000) {
            return Promise.resolve(csrfToken)
        }
        return fetchSessionToken()
    }

    // Manual Action Center Logic
    function fetchManualActions() {
        if (!manualActionsTbody) return
        const params = new URLSearchParams()
        if (manualSearchQuery) params.append('search', manualSearchQuery)
        if (manualLifecycle !== 'all') params.append('lifecycleState', manualLifecycle)
        if (manualVerification !== 'all') params.append('verificationState', manualVerification)
        if (currentManualCursor) params.append('cursor', currentManualCursor)
        params.append('limit', '20')

        fetch('/api/manual-actions?' + params.toString())
            .then(function (res) {
                if (!res.ok) throw new Error('Gagal mengambil task manual')
                return res.json()
            })
            .then(function (data) {
                currentManualRecords = data.records || []
                nextManualCursor = data.nextCursor || null
                renderManualActionsTable(currentManualRecords, data.totalMatching || 0)
            })
            .catch(function (err) {
                console.warn('[DASHBOARD-MANUAL] Fetch error:', err.message)
            })
    }

    function renderManualActionsTable(records, totalMatching) {
        while (manualActionsTbody.firstChild) {
            manualActionsTbody.removeChild(manualActionsTbody.firstChild)
        }

        if (records.length === 0) {
            manualEmptyState.classList.remove('hidden')
        } else {
            manualEmptyState.classList.add('hidden')
        }

        records.forEach(function (rec) {
            const tr = document.createElement('tr')

            const tdAcc = document.createElement('td')
            tdAcc.className = 'font-mono font-medium'
            tdAcc.textContent = rec.displayAccount || 'unknown'

            const tdTitle = document.createElement('td')
            tdTitle.className = 'font-medium'
            tdTitle.textContent = rec.title

            const tdKind = document.createElement('td')
            const kindBadge = document.createElement('span')
            kindBadge.className = 'badge badge-gray'
            kindBadge.textContent = rec.taskKind
            tdKind.appendChild(kindBadge)

            const tdPoints = document.createElement('td')
            tdPoints.className = 'font-bold'
            tdPoints.textContent = rec.advertisedPoints != null ? rec.advertisedPoints + ' pts' : '—'

            const tdLifecycle = document.createElement('td')
            const lifeInfo = LIFECYCLE_MAP[rec.lifecycleState] || { label: rec.lifecycleState, className: 'badge-gray' }
            tdLifecycle.appendChild(createBadge(lifeInfo.label, lifeInfo.className))

            const tdVerification = document.createElement('td')
            const verInfo = VERIFICATION_MAP[rec.verificationState] || {
                label: rec.verificationState,
                className: 'badge-gray'
            }
            tdVerification.appendChild(createBadge(verInfo.label, verInfo.className))

            const tdObserved = document.createElement('td')
            tdObserved.className = 'text-muted'
            tdObserved.textContent = formatTime(rec.observedAt)

            const tdActions = document.createElement('td')

            if (rec.lifecycleState !== 'action-reported' && rec.lifecycleState !== 'dismissed') {
                const btnReport = document.createElement('button')
                btnReport.type = 'button'
                btnReport.className = 'btn-action-report'
                btnReport.textContent = 'Lapor Selesai'
                btnReport.setAttribute('aria-label', 'Laporkan selesai untuk ' + rec.title)
                btnReport.addEventListener('click', function () {
                    openReportModal(rec)
                })
                tdActions.appendChild(btnReport)
            }

            if (rec.lifecycleState !== 'dismissed') {
                const btnDismiss = document.createElement('button')
                btnDismiss.type = 'button'
                btnDismiss.className = 'btn-action-dismiss'
                btnDismiss.textContent = 'Lewati'
                btnDismiss.setAttribute('aria-label', 'Lewati ' + rec.title)
                btnDismiss.addEventListener('click', function () {
                    mutateAction(rec.recordId, 'dismiss', rec.revision)
                })
                tdActions.appendChild(btnDismiss)
            } else {
                const btnReopen = document.createElement('button')
                btnReopen.type = 'button'
                btnReopen.className = 'btn-action-reopen'
                btnReopen.textContent = 'Buka Ulang'
                btnReopen.setAttribute('aria-label', 'Buka ulang ' + rec.title)
                btnReopen.addEventListener('click', function () {
                    mutateAction(rec.recordId, 'reopen', rec.revision)
                })
                tdActions.appendChild(btnReopen)
            }

            tr.appendChild(tdAcc)
            tr.appendChild(tdTitle)
            tr.appendChild(tdKind)
            tr.appendChild(tdPoints)
            tr.appendChild(tdLifecycle)
            tr.appendChild(tdVerification)
            tr.appendChild(tdObserved)
            tr.appendChild(tdActions)

            manualActionsTbody.appendChild(tr)
        })

        // Update pagination controls
        btnManualPrev.disabled = manualCursorHistory.length === 0
        btnManualNext.disabled = !nextManualCursor
        manualPageInfo.textContent = 'Total: ' + totalMatching + ' cocok'
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
                })
            })
            .then(function (res) {
                if (res.status === 409) {
                    announce('Konflik: Task telah diubah bersamaan. Memperbarui.')
                    alert('Konflik: Task telah dimodifikasi bersamaan oleh proses lain. Tampilan akan dimuat ulang.')
                    fetchManualActions()
                    return null
                }
                if (res.status === 403) {
                    announce('Token CSRF kedaluwarsa. Memperbarui sesi.')
                    fetchSessionToken().then(function () {
                        fetchManualActions()
                    })
                    return null
                }
                if (!res.ok) {
                    throw new Error('Aksi gagal dengan status ' + res.status)
                }
                return res.json()
            })
            .then(function (data) {
                if (data && data.success) {
                    announce('Task manual berhasil diperbarui.')
                    fetchManualActions()
                }
            })
            .catch(function (err) {
                console.error('[DASHBOARD-MUTATE] Error:', err.message)
            })
    }

    function openReportModal(rec) {
        activeReportingRecord = rec
        reportModalTaskTitle.textContent = rec.title + ' (' + (rec.displayAccount || '') + ')'
        reportNoteInput.value = ''
        reportModal.classList.remove('hidden')
        reportNoteInput.focus()
    }

    function closeReportModal() {
        reportModal.classList.add('hidden')
        activeReportingRecord = null
    }

    // Navigation Tab Switching
    function switchTab(targetTab) {
        if (targetTab === 'manual') {
            tabReadiness.classList.remove('active')
            tabReadiness.setAttribute('aria-selected', 'false')
            tabManual.classList.add('active')
            tabManual.setAttribute('aria-selected', 'true')
            viewReadiness.classList.add('hidden')
            viewManual.classList.remove('hidden')
            fetchManualActions()
        } else {
            tabManual.classList.remove('active')
            tabManual.setAttribute('aria-selected', 'false')
            tabReadiness.classList.add('active')
            tabReadiness.setAttribute('aria-selected', 'true')
            viewManual.classList.add('hidden')
            viewReadiness.classList.remove('hidden')
        }
    }

    // Event Listeners - Navigation
    if (tabReadiness) {
        tabReadiness.addEventListener('click', function () {
            switchTab('readiness')
        })
    }
    if (tabManual) {
        tabManual.addEventListener('click', function () {
            switchTab('manual')
        })
    }

    // Event Listeners - Technical Readiness
    searchInput.addEventListener('input', function (e) {
        searchQuery = e.target.value.trim()
        renderTable()
    })

    statusFilter.addEventListener('change', function (e) {
        activeFilterStatus = e.target.value
        renderTable()
    })

    sortBySelect.addEventListener('change', function (e) {
        sortBy = e.target.value
        renderTable()
    })

    if (btnResetFilter) {
        btnResetFilter.addEventListener('click', function () {
            searchQuery = ''
            searchInput.value = ''
            activeFilterStatus = 'all'
            statusFilter.value = 'all'
            renderTable()
            searchInput.focus()
        })
    }

    function sendControlAction(action) {
        if (controlInFlight) return
        controlInFlight = true
        updateHeaderStatus()

        getValidCsrfToken()
            .then(function (token) {
                return fetch('/api/control', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': token || ''
                    },
                    body: JSON.stringify({ action: action })
                })
            })
            .then(function (res) {
                if (res.status === 403) {
                    announce('Token CSRF kedaluwarsa. Memperbarui sesi.')
                    return fetchSessionToken().then(function () {
                        throw new Error('Sesi CSRF diperbarui, silakan coba lagi.')
                    })
                }
                if (res.status === 429) {
                    throw new Error('Terlalu banyak permintaan (rate limit). Mohon tunggu beberapa saat.')
                }
                if (!res.ok && res.status !== 202) {
                    return res.json().then(function (errData) {
                        throw new Error(errData.error || 'Permintaan gagal dengan status ' + res.status)
                    })
                }
                return res.json()
            })
            .then(function (data) {
                if (data && data.message) {
                    announce(data.message)
                }
                if (data && data.monitoring) {
                    currentMonitoring = data.monitoring
                } else if (data && data.action === 'recheck') {
                    if (currentMonitoring) {
                        currentMonitoring.checkingState = 'checking'
                        currentMonitoring.activeCheckId = data.checkId
                    }
                }
                updateHeaderStatus()
            })
            .catch(function (err) {
                console.error('[DASHBOARD-CONTROL] Error:', err.message)
                announce('Error: ' + err.message)
                alert('Gagal menjalankan kontrol: ' + err.message)
            })
            .finally(function () {
                controlInFlight = false
                updateHeaderStatus()
            })
    }

    if (btnRecheck) {
        btnRecheck.addEventListener('click', function () {
            sendControlAction('recheck')
        })
    }

    if (btnToggleMonitoring) {
        btnToggleMonitoring.addEventListener('click', function () {
            const isPaused = currentMonitoring && currentMonitoring.monitoringState === 'paused'
            if (isPaused) {
                sendControlAction('resume')
            } else {
                sendControlAction('pause')
            }
        })
    }

    btnRefresh.addEventListener('click', function () {
        fetchStatus()
    })

    btnCloseModal.addEventListener('click', closeModal)
    btnModalDone.addEventListener('click', closeModal)
    detailModal.addEventListener('click', function (e) {
        if (e.target === detailModal) closeModal()
    })

    // Event Listeners - Manual Action Center
    if (manualSearchInput) {
        manualSearchInput.addEventListener('input', function (e) {
            manualSearchQuery = e.target.value.trim()
            currentManualCursor = null
            manualCursorHistory = []
            fetchManualActions()
        })
    }

    if (manualLifecycleFilter) {
        manualLifecycleFilter.addEventListener('change', function (e) {
            manualLifecycle = e.target.value
            currentManualCursor = null
            manualCursorHistory = []
            fetchManualActions()
        })
    }

    if (manualVerificationFilter) {
        manualVerificationFilter.addEventListener('change', function (e) {
            manualVerification = e.target.value
            currentManualCursor = null
            manualCursorHistory = []
            fetchManualActions()
        })
    }

    if (btnManualRefresh) {
        btnManualRefresh.addEventListener('click', function () {
            fetchManualActions()
        })
    }

    if (btnManualNext) {
        btnManualNext.addEventListener('click', function () {
            if (nextManualCursor) {
                manualCursorHistory.push(currentManualCursor)
                currentManualCursor = nextManualCursor
                fetchManualActions()
            }
        })
    }

    if (btnManualPrev) {
        btnManualPrev.addEventListener('click', function () {
            if (manualCursorHistory.length > 0) {
                currentManualCursor = manualCursorHistory.pop() || null
                fetchManualActions()
            }
        })
    }

    // Event Listeners - Report Modal
    if (btnCloseReportModal) btnCloseReportModal.addEventListener('click', closeReportModal)
    if (btnCancelReport) btnCancelReport.addEventListener('click', closeReportModal)
    if (reportModal) {
        reportModal.addEventListener('click', function (e) {
            if (e.target === reportModal) closeReportModal()
        })
    }

    if (btnSubmitReport) {
        btnSubmitReport.addEventListener('click', function () {
            if (!activeReportingRecord) return
            const note = reportNoteInput.value.trim()
            const recId = activeReportingRecord.recordId
            const rev = activeReportingRecord.revision
            closeReportModal()
            mutateAction(recId, 'report', rev, note)
        })
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            if (!detailModal.classList.contains('hidden')) closeModal()
            if (reportModal && !reportModal.classList.contains('hidden')) closeReportModal()
        }
    })

    // Apply Snapshot with Monotonic Revision & Cross-Runtime Protection
    function applySnapshot(snapshot) {
        if (!snapshot || !snapshot.runtime) return

        const snapStartTime = Date.parse(snapshot.runtime.runtimeStartTime) || 0
        const snapRevision = typeof snapshot.revision === 'number' ? snapshot.revision : 0
        const snapRuntimeId = snapshot.runtimeId || ''

        // 1. Cross-runtime protection: reject snapshot from older runtimes
        if (currentRuntimeStartTime > 0 && snapStartTime < currentRuntimeStartTime) {
            console.warn('[DASHBOARD] Ignored stale snapshot from prior runtime instance')
            return
        }

        // 2. Intra-runtime monotonic revision check: reject older revisions
        if (snapRuntimeId === currentRuntimeId && snapRevision < currentRevision) {
            console.warn('[DASHBOARD] Ignored stale revision:', snapRevision, 'current:', currentRevision)
            return
        }

        // Accept and commit snapshot
        currentRuntimeId = snapRuntimeId
        currentRuntimeStartTime = snapStartTime
        currentRevision = snapRevision

        currentAccounts = snapshot.accounts || []
        currentSummary = snapshot.summary || null
        currentDataSource = snapshot.dataSource || null
        currentRuntime = snapshot.runtime || null
        currentMonitoring = snapshot.monitoring || null
        currentBridgeDiagnostics = snapshot.bridgeDiagnostics || null

        // Update timestamps
        if (timeSnapshot) timeSnapshot.textContent = formatTime(snapshot.generatedAt)
        if (timeDataLoaded) {
            timeDataLoaded.textContent =
                currentDataSource && currentDataSource.lastLoadedAt ? formatTime(currentDataSource.lastLoadedAt) : '—'
        }

        // Update rejected counter badge
        if (metricRejected) {
            const rejCount = currentDataSource ? currentDataSource.rejectedCount : 0
            if (rejCount > 0) {
                metricRejected.classList.remove('hidden')
                metricRejected.textContent = rejCount + ' Ditolak'
                metricRejected.title = currentDataSource.rejectionReasons
                    ? currentDataSource.rejectionReasons.join('\n')
                    : 'Konfigurasi akun tidak valid'
            } else {
                metricRejected.classList.add('hidden')
            }
        }

        updateHeaderStatus()
        updateGuidanceBanner()
        updateSummaryCards(currentSummary)
        renderTable()
    }

    // Fetch Status via HTTP: calls fetch('/api/status') (fallback and manual refresh)
    function fetchStatus() {
        if (btnRefresh) btnRefresh.disabled = true

        if (inFlightAbortController) {
            inFlightAbortController.abort()
        }
        inFlightAbortController = new AbortController()

        fetch('/api/status', { signal: inFlightAbortController.signal })
            .then(function (res) {
                if (!res.ok) throw new Error('Status fetch failed: ' + res.status)
                return res.json()
            })
            .then(function (data) {
                connectionState = 'connected'
                applySnapshot(data)
            })
            .catch(function (err) {
                if (err.name === 'AbortError') return
                console.warn('[DASHBOARD] Local status fetch error:', err.message)
                if (connectionState === 'connected') {
                    connectionState = 'reconnecting'
                    updateHeaderStatus()
                    updateGuidanceBanner()
                }
            })
            .finally(function () {
                if (btnRefresh) btnRefresh.disabled = false
            })
    }

    // Connect to SSE for Live Real-Time Updates
    function connectSse() {
        if (!window.EventSource) {
            connectionState = 'connected'
            fetchStatus()
            return
        }

        if (sseSource) {
            sseSource.close()
            sseSource = null
        }

        try {
            sseSource = new EventSource('/api/events')

            sseSource.addEventListener('snapshot', function (e) {
                try {
                    const data = JSON.parse(e.data)
                    connectionState = 'connected'
                    applySnapshot(data)
                    // Clear fallback polling since SSE is healthy
                    if (fallbackPollTimer) {
                        clearInterval(fallbackPollTimer)
                        fallbackPollTimer = null
                    }
                } catch (err) {
                    console.error('[DASHBOARD-SSE] Malformed event payload')
                }
            })

            sseSource.onerror = function () {
                connectionState = 'reconnecting'
                updateHeaderStatus()
                updateGuidanceBanner()

                // Activate bounded fallback polling if not already active
                if (!fallbackPollTimer) {
                    fallbackPollTimer = setInterval(function () {
                        fetchStatus()
                    }, 8000)
                }
            }

            sseSource.onopen = function () {
                connectionState = 'connected'
                updateHeaderStatus()
                updateGuidanceBanner()
                if (fallbackPollTimer) {
                    clearInterval(fallbackPollTimer)
                    fallbackPollTimer = null
                }
            }
        } catch (e) {
            console.warn('[DASHBOARD-SSE] Falling back to polling:', e)
            connectionState = 'connected'
            fetchStatus()
        }
    }

    // Window Unload Cleanup
    window.addEventListener('beforeunload', function () {
        if (sseSource) {
            sseSource.close()
            sseSource = null
        }
        if (fallbackPollTimer) {
            clearInterval(fallbackPollTimer)
            fallbackPollTimer = null
        }
        if (inFlightAbortController) {
            inFlightAbortController.abort()
            inFlightAbortController = null
        }
    })

    // Initialization
    connectionState = 'connecting'
    updateHeaderStatus()
    fetchStatus()
    connectSse()
    fetchSessionToken()
})()
