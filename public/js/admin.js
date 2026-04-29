const state = {
  entries: [],
  entriesTotal: 0,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  personnel: [],
  driveLinks: [],
  cycles: [],
  stats: null,
  filters: { search: '', cycle: '', status: '', personnel_id: '' },
  selected: new Set(),
  audit: { data: [], total: 0, page: 1, pageSize: 50, totalPages: 1, filters: { search: '', action: '', actor_id: '' } }
};

const charts = {};

const user = requireAuth('admin');
let activateTab;

if (user) {
  document.getElementById('userLabel').textContent = user.full_name;
  document.getElementById('userAvatar').textContent = user.full_name.slice(0, 1).toUpperCase();
  logoutSetup();
  applyChartDefaults();

  document.getElementById('menuToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  activateTab = setupTabs((tab) => {
    document.getElementById('sidebar').classList.remove('open');
    if (tab === 'reports') loadReports();
    if (tab === 'audit') loadAuditLog();
  });

  init();
}

async function init() {
  await refresh();
  setupFilters();
  setupModals();
  setupSelection();
  setupAuditFilters();
  setupAdminPdfAutofill();
  setupCrossCheck();
  setupBulkImport();
  document.getElementById('reportPeriod').addEventListener('change', loadReports);
  document.getElementById('transferAllBtn').addEventListener('click', transferAllUnpaid);
  document.getElementById('exportCsvBtn').addEventListener('click', exportEntriesCsv);
  document.getElementById('exportReportBtn').addEventListener('click', exportEntriesCsv);
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  refreshIcons();
}

async function refresh() {
  try {
    const [entriesResp, personnel, driveLinks, cycles, stats, digest, dups] = await Promise.all([
      fetchEntries(),
      API.fetch('/api/admin/personnel'),
      API.fetch('/api/drive-links'),
      API.fetch('/api/admin/cycles'),
      API.fetch('/api/admin/stats'),
      API.fetch('/api/admin/friday-digest'),
      API.fetch('/api/admin/duplicates?days=14').catch(() => ({ duplicates: [] }))
    ]);
    applyEntriesResp(entriesResp);
    state.personnel = personnel;
    state.driveLinks = driveLinks;
    state.cycles = cycles;
    state.stats = stats;
    state.digest = digest;
    state.duplicates = dups.duplicates || [];
    renderDashboard();
    renderDashAlerts();
    renderEntries();
    renderPersonnel();
    renderDriveLinks();
    populateFilters();
    populatePersonnelOptions();
    updatePendingBadge();
    refreshIcons();
  } catch (e) {
    console.error(e);
    toast(e.message, 'error');
  }
}

function renderDashAlerts() {
  const el = document.getElementById('dashAlerts');
  if (!el) return;
  const blocks = [];
  const d = state.digest;
  if (d) {
    const items = [];
    if (d.pendingToVerify?.c > 0) {
      items.push(`<span class="font-semibold">${d.pendingToVerify.c}</span> ${d.pendingToVerify.c === 1 ? 'sale needs' : 'sales need'} review (<span class="font-semibold">${fmtMoney(d.pendingToVerify.total)}</span>)`);
    }
    if (d.totalPayout > 0) items.push(`<span class="font-semibold">${fmtMoney(d.totalPayout)}</span> already paid this cycle`);
    if (d.topPerformer?.full_name && d.topPerformer.total > 0) {
      items.push(`Top performer: <span class="font-semibold">${escapeHtml(d.topPerformer.full_name)}</span> (${fmtMoney(d.topPerformer.total)})`);
    }
    if (items.length) {
      blocks.push(`
        <div class="rounded-2xl p-4 lg:p-5 text-white shadow-sm flex items-start gap-3"
             style="background: linear-gradient(135deg, #0b2545 0%, #1e4d8c 100%);">
          <div class="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center shrink-0">
            <i data-lucide="${d.isFriday ? 'calendar-check' : 'sparkles'}" class="w-5 h-5"></i>
          </div>
          <div class="flex-1">
            <div class="font-bold">${d.isFriday ? "It's payout Friday — here's the snapshot" : 'Cycle snapshot'}</div>
            <div class="text-sm text-white/85 mt-1 leading-relaxed">${items.join(' &middot; ')}</div>
          </div>
        </div>
      `);
    }
  }

  if (state.duplicates && state.duplicates.length) {
    blocks.push(`
      <div class="rounded-2xl border border-amber-300 bg-amber-50 p-4 lg:p-5 flex items-start gap-3">
        <div class="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <i data-lucide="alert-triangle" class="w-5 h-5"></i>
        </div>
        <div class="flex-1">
          <div class="font-bold text-amber-900">Possible duplicate sales detected</div>
          <div class="text-sm text-amber-800 mt-1">
            ${state.duplicates.slice(0, 3).map(d => `<div>${escapeHtml(d.personnel_name)} — <strong>${fmtMoney(d.sale_amount)}</strong> for "${escapeHtml(d.match_key)}" appears <strong>${d.count}×</strong> in last 14 days</div>`).join('')}
            ${state.duplicates.length > 3 ? `<div class="mt-1 text-xs text-amber-700">and ${state.duplicates.length - 3} more...</div>` : ''}
          </div>
          <button onclick="filterByDuplicates()" class="mt-3 text-xs font-semibold text-amber-900 hover:text-amber-700 underline">Review these sales →</button>
        </div>
      </div>
    `);
  }

  el.innerHTML = blocks.join('');
  refreshIcons();
}

function renderAdminBreakdown(e) {
  const sale = e.sale_amount || 0;
  const ded = e.deductions || 0;
  const bon = e.bonuses || 0;
  const base = Math.max(0, sale - ded);
  const gross = (base * (e.commission_rate || 70)) / 100;
  return `
    <div class="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div class="text-xs font-semibold text-indigo-900 uppercase tracking-wide mb-2">Commission Breakdown</div>
      <dl class="text-sm space-y-1">
        <div class="flex justify-between"><dt class="text-slate-600">Sale amount</dt><dd class="text-slate-900">${fmtMoney(sale)}</dd></div>
        ${ded > 0 ? `<div class="flex justify-between"><dt class="text-slate-600">Less: deductions</dt><dd class="text-slate-900">−${fmtMoney(ded)}</dd></div>` : ''}
        <div class="flex justify-between border-t border-indigo-200 pt-1.5 mt-1.5"><dt class="text-slate-700 font-medium">Commissionable base</dt><dd class="font-semibold text-slate-900">${fmtMoney(base)}</dd></div>
        <div class="flex justify-between"><dt class="text-slate-600">× ${e.commission_rate}%</dt><dd class="text-slate-900">${fmtMoney(gross)}</dd></div>
        ${bon > 0 ? `<div class="flex justify-between"><dt class="text-slate-600">+ Bonus</dt><dd class="text-slate-900">+${fmtMoney(bon)}</dd></div>` : ''}
        <div class="flex justify-between border-t-2 border-indigo-300 pt-2 mt-1"><dt class="text-base font-bold text-indigo-900">Final payout</dt><dd class="text-base font-extrabold text-indigo-900">${fmtMoney(e.commission_amount)}</dd></div>
      </dl>
    </div>
  `;
}

window.filterByDuplicates = function() {
  if (!state.duplicates?.length) return;
  // Filter the entries list to just those duplicate IDs by personnel of first group
  const first = state.duplicates[0];
  state.filters.personnel_id = String(first.personnel_id);
  document.getElementById('personnelFilter').value = state.filters.personnel_id;
  state.page = 1;
  reloadEntries();
  if (typeof activateTab === 'function') activateTab('entries');
};

function applyEntriesResp(resp) {
  state.entries = resp.data || [];
  state.entriesTotal = resp.total || 0;
  state.page = resp.page || 1;
  state.totalPages = resp.totalPages || 1;
  state.pageSize = resp.pageSize || state.pageSize;
}

async function fetchEntries() {
  const q = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => { if (v) q.set(k, v); });
  q.set('page', state.page);
  q.set('pageSize', state.pageSize);
  return API.fetch('/api/admin/entries?' + q.toString());
}

function updatePendingBadge() {
  const badge = document.getElementById('pendingBadge');
  const count = state.stats?.pendingCount || 0;
  if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

// ========== Dashboard ==========
function renderDashboard() {
  const s = state.stats;
  if (!s) return;

  document.getElementById('dashCurrentCycle').textContent = fmtDate(s.currentCycle);

  document.getElementById('kpiCommission').textContent = fmtMoney(s.currentCycleStats.commission, { compact: false });
  document.getElementById('kpiSales').textContent = fmtMoney(s.currentCycleStats.sales, { compact: false });
  document.getElementById('kpiPending').textContent = fmtInt(s.pendingCount);
  document.getElementById('kpiPersonnel').textContent = fmtInt(s.activePersonnel);

  document.getElementById('kpiCommissionTrend').innerHTML = `
    ${trendChip(s.currentCycleStats.commission, s.prevCycleStats.commission)}
    <span class="text-xs text-slate-500 ml-1">vs last cycle</span>
  `;
  document.getElementById('kpiSalesTrend').innerHTML = `
    ${trendChip(s.currentCycleStats.sales, s.prevCycleStats.sales)}
    <span class="text-xs text-slate-500 ml-1">vs last cycle</span>
  `;

  document.getElementById('settingsTotalEntries').textContent = fmtInt(s.totals.totalEntries);
  document.getElementById('settingsTotalCommission').textContent = fmtMoney(s.totals.totalCommission);

  renderTrendChart(s.weeklyTrend);
  renderStatusChart(s.statusBreakdown);
  renderLeaderboard(s.leaderboard);
  renderPendingList();

  refreshIcons();
}

function renderTrendChart(data) {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  const labels = data.map(d => fmtDateShort(d.cycle));
  const commission = data.map(d => d.commission);
  const sales = data.map(d => d.sales);
  if (charts.trend) charts.trend.destroy();
  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, 'rgba(11, 37, 69, 0.28)');
  gradient.addColorStop(1, 'rgba(11, 37, 69, 0)');
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Commission', data: commission, borderColor: '#0b2545', backgroundColor: gradient, tension: 0.4, fill: true, pointRadius: 3, pointBackgroundColor: '#0b2545', borderWidth: 2.5 },
        { label: 'Sales', data: sales, borderColor: '#ffb703', backgroundColor: 'transparent', tension: 0.4, pointRadius: 3, pointBackgroundColor: '#ffb703', borderWidth: 2, borderDash: [4, 4] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 8, boxHeight: 8 } },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtMoney(c.parsed.y)}` } }
      },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => fmtMoney(v, { compact: true }) }, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false } }
      }
    }
  });
}

function renderStatusChart(breakdown) {
  const ctx = document.getElementById('statusChart');
  if (!ctx) return;
  const map = { paid: 0, pending: 0, unpaid: 0 };
  breakdown.forEach(b => map[b.status] = b.count);
  const total = map.paid + map.pending + map.unpaid;
  if (charts.status) charts.status.destroy();
  if (total === 0) {
    ctx.parentElement.innerHTML = '<div class="text-center text-slate-400 text-sm py-12"><i data-lucide="pie-chart" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>No entries in current cycle</div>';
    refreshIcons();
    return;
  }
  charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Paid', 'Pending', 'Unpaid'],
      datasets: [{
        data: [map.paid, map.pending, map.unpaid],
        backgroundColor: ['#10b981', '#f59e0b', '#f43f5e'],
        borderWidth: 0,
        spacing: 2
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 12, boxWidth: 8, boxHeight: 8 } },
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${c.parsed} (${((c.parsed/total)*100).toFixed(0)}%)` } }
      }
    }
  });
}

function renderLeaderboard(list) {
  const el = document.getElementById('leaderboard');
  const filtered = list.filter(x => x.commission > 0 || x.entry_count > 0);
  if (!filtered.length) {
    el.innerHTML = '<div class="text-center text-slate-400 text-sm py-6">No activity this cycle</div>';
    return;
  }
  const max = filtered[0].commission || 1;
  el.innerHTML = filtered.map((p, i) => {
    const pct = (p.commission / max) * 100;
    const medals = ['bg-amber-400 text-white', 'bg-slate-300 text-slate-700', 'bg-orange-300 text-white'];
    return `
      <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50">
        <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${medals[i] || 'bg-slate-100 text-slate-600'}">${i + 1}</div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <div class="text-sm font-medium text-slate-800 truncate">${escapeHtml(p.full_name)}</div>
            <div class="text-sm font-semibold text-slate-900 whitespace-nowrap">${fmtMoney(p.commission)}</div>
          </div>
          <div class="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div class="h-full bg-brand-gradient" style="width: ${pct}%"></div>
          </div>
          <div class="text-xs text-slate-500 mt-1">${p.entry_count} ${p.entry_count === 1 ? 'entry' : 'entries'}</div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPendingList() {
  const el = document.getElementById('pendingList');
  const pending = state.entries.filter(e => e.status === 'pending').slice(0, 5);
  if (!pending.length) {
    el.innerHTML = '<div class="text-center text-slate-400 text-sm py-6"><i data-lucide="check-circle-2" class="w-8 h-8 mx-auto mb-2 text-emerald-300"></i>All caught up!</div>';
    refreshIcons();
    return;
  }
  el.innerHTML = pending.map(e => `
    <div class="flex items-center gap-3 p-3 rounded-lg border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 cursor-pointer transition" onclick="openEdit(${e.id})">
      <div class="w-9 h-9 rounded-full bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center text-xs font-semibold text-indigo-700 shrink-0">
        ${escapeHtml(e.personnel_name.slice(0, 1).toUpperCase())}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-800 truncate">${escapeHtml(e.description)}</div>
        <div class="text-xs text-slate-500">${escapeHtml(e.personnel_name)} · ${fmtDateShort(e.sale_date)}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-sm font-semibold text-slate-900">${fmtMoney(e.commission_amount)}</div>
        <div class="text-xs text-slate-500">${e.commission_rate}%</div>
      </div>
    </div>
  `).join('');
  refreshIcons();
}

window.goToEntries = function() {
  if (activateTab) activateTab('entries');
  state.filters.status = 'pending';
  document.getElementById('statusFilter').value = 'pending';
  reloadEntries();
  history.replaceState(null, '', '?tab=entries');
};

// ========== Entries ==========
function populateFilters() {
  const cycleSel = document.getElementById('cycleFilter');
  const curVal = cycleSel.value;
  cycleSel.innerHTML = '<option value="">All cycles</option>' +
    state.cycles.map(c => `<option value="${c}">${fmtDate(c)}</option>`).join('');
  cycleSel.value = curVal;

  const pSel = document.getElementById('personnelFilter');
  const pVal = pSel.value;
  pSel.innerHTML = '<option value="">All personnel</option>' +
    state.personnel.map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
  pSel.value = pVal;
}

function populatePersonnelOptions() {
  const sel = document.querySelector('#newAdminEntryForm select[name="personnel_id"]');
  if (sel) {
    sel.innerHTML = '<option value="">Select personnel...</option>' +
      state.personnel.filter(p => p.active).map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');
  }
}

function setupFilters() {
  const debounce = (fn, d = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; };
  document.getElementById('searchInput').addEventListener('input', debounce(e => { state.filters.search = e.target.value; state.page = 1; reloadEntries(); }));
  document.getElementById('cycleFilter').addEventListener('change', e => { state.filters.cycle = e.target.value; state.page = 1; reloadEntries(); });
  document.getElementById('statusFilter').addEventListener('change', e => { state.filters.status = e.target.value; state.page = 1; reloadEntries(); });
  document.getElementById('personnelFilter').addEventListener('change', e => { state.filters.personnel_id = e.target.value; state.page = 1; reloadEntries(); });
}

async function reloadEntries() {
  try {
    const resp = await fetchEntries();
    applyEntriesResp(resp);
    renderEntries();
    refreshIcons();
  } catch (e) { toast(e.message, 'error'); }
}

window.goToPage = async function(p) {
  if (p < 1 || p > state.totalPages || p === state.page) return;
  state.page = p;
  await reloadEntries();
};

window.changePageSize = async function(size) {
  state.pageSize = parseInt(size);
  state.page = 1;
  await reloadEntries();
};

function renderEntries() {
  const tbody = document.getElementById('entriesBody');
  if (!state.entries.length) {
    tbody.innerHTML = `<tr><td colspan="11" class="px-4 py-10 text-center text-slate-500">
      <i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <div>No entries match your filters.</div>
    </td></tr>`;
    renderEntriesPagination();
    updateBulkBar();
    return;
  }
  tbody.innerHTML = state.entries.map(e => `
    <tr class="${state.selected.has(e.id) ? 'bg-indigo-50/40' : ''}">
      <td class="px-3 py-3 align-top"><input type="checkbox" class="row-check rounded border-slate-300" data-id="${e.id}" ${state.selected.has(e.id) ? 'checked' : ''} /></td>
      <td class="px-4 py-3 whitespace-nowrap text-slate-600 align-top">${fmtDate(e.sale_date)}</td>
      <td class="px-4 py-3 align-top">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-full bg-gradient-to-br from-indigo-100 to-violet-100 flex items-center justify-center text-xs font-semibold text-indigo-700 shrink-0">${escapeHtml(e.personnel_name.slice(0,1).toUpperCase())}</div>
          <span class="font-medium text-slate-800">${escapeHtml(e.personnel_name)}</span>
        </div>
      </td>
      <td class="px-4 py-3 align-top">
        <div class="font-medium text-slate-800">${escapeHtml(e.description)}
          ${e.drive_link ? `<a href="${escapeAttr(e.drive_link)}" target="_blank" rel="noopener" class="inline-flex items-center ml-1 text-indigo-500 hover:text-indigo-700" title="Drive link"><i data-lucide="external-link" class="w-3 h-3"></i></a>` : ''}
          ${e.attachment_count > 0 ? `<span class="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-medium" title="${e.attachment_count} attachment${e.attachment_count === 1 ? '' : 's'}"><i data-lucide="paperclip" class="w-3 h-3"></i>${e.attachment_count}</span>` : ''}
        </div>
      </td>
      <td class="px-4 py-3 text-right whitespace-nowrap align-top">${fmtMoney(e.sale_amount)}</td>
      <td class="px-4 py-3 text-center align-top">
        <span class="inline-block px-2 py-0.5 rounded-md text-xs font-medium ${e.commission_rate === 70 ? 'bg-indigo-50 text-indigo-700' : 'bg-violet-50 text-violet-700'}">${e.commission_rate}%</span>
      </td>
      <td class="px-4 py-3 text-right font-semibold whitespace-nowrap align-top">${fmtMoney(e.commission_amount)}</td>
      <td class="px-4 py-3 whitespace-nowrap text-slate-600 align-top">${fmtDate(e.billing_cycle_date)}</td>
      <td class="px-4 py-3 align-top">${statusBadge(e.status)}</td>
      <td class="px-4 py-3 align-top max-w-[220px]">
        ${e.notes
          ? `<div class="text-xs text-slate-600 whitespace-pre-line line-clamp-3" title="${escapeAttr(e.notes)}">${escapeHtml(e.notes)}</div>`
          : '<span class="text-xs text-slate-300">—</span>'}
      </td>
      <td class="px-4 py-3 whitespace-nowrap align-top">
        <div class="flex items-center gap-1">
          <button onclick="openEdit(${e.id})" class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Verify / Edit"><i data-lucide="check-circle-2" class="w-4 h-4"></i></button>
          <button onclick="transferEntry(${e.id})" class="p-1.5 text-slate-500 hover:text-amber-600 hover:bg-amber-50 rounded" title="Move to next cycle"><i data-lucide="arrow-right-circle" class="w-4 h-4"></i></button>
          <button onclick="deleteEntry(${e.id})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  renderEntriesPagination();
  updateBulkBar();
}

// ========== Selection & bulk actions ==========
function setupSelection() {
  // Delegated change handler on tbody
  document.getElementById('entriesBody').addEventListener('change', (e) => {
    const cb = e.target.closest('.row-check');
    if (!cb) return;
    const id = parseInt(cb.dataset.id);
    if (cb.checked) state.selected.add(id);
    else state.selected.delete(id);
    cb.closest('tr')?.classList.toggle('bg-indigo-50/40', cb.checked);
    updateBulkBar();
    syncSelectAllCheckbox();
  });
  document.getElementById('selectAllCheckbox').addEventListener('change', (e) => {
    const checked = e.target.checked;
    state.entries.forEach(en => checked ? state.selected.add(en.id) : state.selected.delete(en.id));
    document.querySelectorAll('.row-check').forEach(cb => {
      cb.checked = checked;
      cb.closest('tr')?.classList.toggle('bg-indigo-50/40', checked);
    });
    updateBulkBar();
  });
}

function syncSelectAllCheckbox() {
  const cb = document.getElementById('selectAllCheckbox');
  if (!cb) return;
  const visibleIds = state.entries.map(e => e.id);
  const allChecked = visibleIds.length > 0 && visibleIds.every(id => state.selected.has(id));
  const someChecked = visibleIds.some(id => state.selected.has(id));
  cb.checked = allChecked;
  cb.indeterminate = !allChecked && someChecked;
}

function updateBulkBar() {
  const bar = document.getElementById('bulkBar');
  const count = state.selected.size;
  document.getElementById('bulkCount').textContent = count;
  bar.classList.toggle('hidden', count === 0);
  bar.classList.toggle('flex', count !== 0);
  syncSelectAllCheckbox();
}

window.clearSelection = function() {
  state.selected.clear();
  document.querySelectorAll('.row-check').forEach(cb => { cb.checked = false; cb.closest('tr')?.classList.remove('bg-indigo-50/40'); });
  updateBulkBar();
};

window.bulkAction = async function(action) {
  if (state.selected.size === 0) return;
  const ids = Array.from(state.selected);
  const count = ids.length;
  try {
    if (action === 'mark-paid' || action === 'mark-unpaid' || action === 'mark-pending') {
      const status = action.replace('mark-', '');
      const ok = await confirmDialog({
        title: `Mark ${count} ${count === 1 ? 'entry' : 'entries'} as ${status}?`,
        confirmText: 'Confirm',
        danger: false
      });
      if (!ok) return;
      const r = await API.fetch('/api/admin/entries/bulk-status', { method: 'POST', body: JSON.stringify({ ids, status }) });
      toast(`${r.updated} ${r.updated === 1 ? 'entry' : 'entries'} marked as ${status}`, 'success');
    } else if (action === 'transfer') {
      const note = await promptDialog({ title: `Transfer ${count} ${count === 1 ? 'entry' : 'entries'}?`, message: 'Reason for moving them to the next cycle (required):', placeholder: 'e.g. Client requested delay', confirmText: 'Move' });
      if (!note || !note.trim()) { if (note !== null) toast('Reason required', 'warn'); return; }
      const r = await API.fetch('/api/admin/entries/bulk-transfer', { method: 'POST', body: JSON.stringify({ ids, note: note.trim() }) });
      toast(`${r.moved} ${r.moved === 1 ? 'entry' : 'entries'} moved to next cycle`, 'success');
    } else if (action === 'delete') {
      const ok = await confirmDialog({
        title: `Delete ${count} ${count === 1 ? 'entry' : 'entries'}?`,
        message: 'This cannot be undone. Attached files will also be removed.',
        confirmText: 'Delete',
        danger: true
      });
      if (!ok) return;
      const r = await API.fetch('/api/admin/entries/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) });
      toast(`${r.deleted} ${r.deleted === 1 ? 'entry' : 'entries'} deleted`, 'success');
    }
    state.selected.clear();
    await refresh();
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ========== Audit log ==========
async function loadAuditLog() {
  try {
    const q = new URLSearchParams();
    Object.entries(state.audit.filters).forEach(([k, v]) => { if (v) q.set(k, v); });
    q.set('page', state.audit.page);
    q.set('pageSize', state.audit.pageSize);
    const [resp, actions] = await Promise.all([
      API.fetch('/api/admin/audit-logs?' + q.toString()),
      API.fetch('/api/admin/audit-actions')
    ]);
    state.audit.data = resp.data;
    state.audit.total = resp.total;
    state.audit.page = resp.page;
    state.audit.totalPages = resp.totalPages;
    populateAuditFilters(actions);
    renderAuditLog();
  } catch (e) { toast(e.message, 'error'); }
}

function populateAuditFilters(actions) {
  const aSel = document.getElementById('auditActionFilter');
  const aVal = aSel.value;
  aSel.innerHTML = '<option value="">All actions</option>' + actions.map(a => `<option value="${a}">${a}</option>`).join('');
  aSel.value = aVal;
  const pSel = document.getElementById('auditActorFilter');
  const pVal = pSel.value;
  // Build personnel list from already-loaded state.personnel + add a row for "admin"
  const opts = [{ id: '', name: 'All users' }, { id: '__admin__', name: 'Admin' }, ...state.personnel.map(p => ({ id: p.id, name: p.full_name }))];
  pSel.innerHTML = opts.map(o => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
  pSel.value = pVal;
}

function actionLabel(action) {
  const map = {
    'login.success': { icon: 'log-in', color: 'text-emerald-600 bg-emerald-50', label: 'Logged in' },
    'login.failed': { icon: 'shield-alert', color: 'text-rose-600 bg-rose-50', label: 'Login failed' },
    'password.changed': { icon: 'key', color: 'text-indigo-600 bg-indigo-50', label: 'Changed password' },
    'entry.created': { icon: 'plus-circle', color: 'text-emerald-600 bg-emerald-50', label: 'Created entry' },
    'entry.created_by_admin': { icon: 'plus-circle', color: 'text-emerald-600 bg-emerald-50', label: 'Created entry (admin)' },
    'entry.edited': { icon: 'edit', color: 'text-amber-600 bg-amber-50', label: 'Edited entry' },
    'entry.verified': { icon: 'check-circle-2', color: 'text-indigo-600 bg-indigo-50', label: 'Verified entry' },
    'entry.deleted': { icon: 'trash-2', color: 'text-rose-600 bg-rose-50', label: 'Deleted entry' },
    'entry.deleted_by_admin': { icon: 'trash-2', color: 'text-rose-600 bg-rose-50', label: 'Deleted entry (admin)' },
    'entry.transferred': { icon: 'arrow-right-circle', color: 'text-amber-600 bg-amber-50', label: 'Transferred entry' },
    'entry.cycle_rollover': { icon: 'arrow-right-circle', color: 'text-amber-600 bg-amber-50', label: 'Cycle rollover' },
    'entry.bulk_status_changed': { icon: 'check-circle-2', color: 'text-indigo-600 bg-indigo-50', label: 'Bulk status change' },
    'entry.bulk_transferred': { icon: 'arrow-right-circle', color: 'text-amber-600 bg-amber-50', label: 'Bulk transfer' },
    'entry.bulk_deleted': { icon: 'trash-2', color: 'text-rose-600 bg-rose-50', label: 'Bulk delete' },
    'attachment.uploaded': { icon: 'paperclip', color: 'text-indigo-600 bg-indigo-50', label: 'Uploaded files' },
    'attachment.deleted': { icon: 'paperclip', color: 'text-rose-600 bg-rose-50', label: 'Deleted file' },
    'personnel.created': { icon: 'user-plus', color: 'text-emerald-600 bg-emerald-50', label: 'Created personnel' },
    'personnel.activated': { icon: 'user-check', color: 'text-emerald-600 bg-emerald-50', label: 'Activated personnel' },
    'personnel.deactivated': { icon: 'user-x', color: 'text-rose-600 bg-rose-50', label: 'Deactivated personnel' },
    'personnel.password_reset': { icon: 'key', color: 'text-amber-600 bg-amber-50', label: 'Reset password' },
    'personnel.updated': { icon: 'edit', color: 'text-slate-600 bg-slate-50', label: 'Updated personnel' }
  };
  return map[action] || { icon: 'circle', color: 'text-slate-600 bg-slate-50', label: action };
}

function renderAuditLog() {
  const tbody = document.getElementById('auditBody');
  if (!state.audit.data.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-4 py-10 text-center text-slate-500">
      <i data-lucide="history" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <div>No matching activity.</div>
    </td></tr>`;
    document.getElementById('auditPagination').innerHTML = '';
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.audit.data.map(r => {
    const lab = actionLabel(r.action);
    let detail = '';
    if (r.metadata) {
      try {
        const m = JSON.parse(r.metadata);
        const parts = [];
        if (m.status_from && m.status_to) parts.push(`${m.status_from} → ${m.status_to}`);
        if (m.rate_from && m.rate_to && m.rate_from !== m.rate_to) parts.push(`${m.rate_from}% → ${m.rate_to}%`);
        if (m.from && m.to) parts.push(`${m.from} → ${m.to}`);
        if (m.cycle_from && m.cycle_to) parts.push(`${m.cycle_from} → ${m.cycle_to}`);
        if (m.commission_amount != null) parts.push(`commission ${fmtMoney(m.commission_amount)}`);
        if (m.count) parts.push(`${m.count} item${m.count === 1 ? '' : 's'}`);
        if (m.affected) parts.push(`${m.affected} affected`);
        if (m.deleted) parts.push(`${m.deleted} deleted`);
        if (m.reason) parts.push(`"${m.reason}"`);
        if (m.username && r.action === 'login.failed') parts.push(`username: ${m.username}`);
        detail = parts.join(' · ');
      } catch {}
    }
    const target = r.target_type ? `${r.target_type}${r.target_id ? ' #' + r.target_id : ''}` : '—';
    return `
      <tr>
        <td class="px-4 py-3 whitespace-nowrap align-top text-slate-600 text-xs">${fmtRelative(r.created_at)}<div class="text-[10px] text-slate-400">${escapeHtml(r.created_at)}</div></td>
        <td class="px-4 py-3 align-top">
          <div class="font-medium text-slate-800">${escapeHtml(r.actor_username || '—')}</div>
          <div class="text-xs text-slate-500">${escapeHtml(r.actor_role || '—')}${r.ip_address ? ' · ' + escapeHtml(r.ip_address) : ''}</div>
        </td>
        <td class="px-4 py-3 align-top">
          <span class="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium ${lab.color}">
            <i data-lucide="${lab.icon}" class="w-3.5 h-3.5"></i>${lab.label}
          </span>
        </td>
        <td class="px-4 py-3 whitespace-nowrap align-top text-slate-600 text-xs">${target}</td>
        <td class="px-4 py-3 align-top text-xs text-slate-600">${escapeHtml(detail)}</td>
      </tr>
    `;
  }).join('');
  renderAuditPagination();
  refreshIcons();
}

function renderAuditPagination() {
  const el = document.getElementById('auditPagination');
  const { page, totalPages, total, pageSize } = state.audit;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const btn = (label, p, disabled = false, active = false) => `
    <button ${disabled ? 'disabled' : ''} ${p != null && !disabled && !active ? `onclick="auditGoToPage(${p})"` : ''}
      class="px-3 py-1.5 text-sm rounded-lg border ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-700 hover:bg-slate-50'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}">${label}</button>`;
  const pages = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= page - 2 && p <= page + 2)) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  el.innerHTML = `
    <div class="text-xs text-slate-500">Showing <strong class="text-slate-700">${from}–${to}</strong> of <strong class="text-slate-700">${total}</strong></div>
    <div class="flex items-center gap-1">
      ${btn('‹', page - 1, page <= 1)}
      ${pages.map(p => p === '…' ? '<span class="px-2 text-slate-400">…</span>' : btn(p, p, false, p === page)).join('')}
      ${btn('›', page + 1, page >= totalPages)}
    </div>
  `;
}

window.auditGoToPage = async function(p) {
  if (p < 1 || p > state.audit.totalPages) return;
  state.audit.page = p;
  await loadAuditLog();
};

function setupAuditFilters() {
  const debounce = (fn, d = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; };
  document.getElementById('auditSearchInput').addEventListener('input', debounce(e => { state.audit.filters.search = e.target.value; state.audit.page = 1; loadAuditLog(); }));
  document.getElementById('auditActionFilter').addEventListener('change', e => { state.audit.filters.action = e.target.value; state.audit.page = 1; loadAuditLog(); });
  document.getElementById('auditActorFilter').addEventListener('change', e => { state.audit.filters.actor_id = e.target.value === '__admin__' ? '1' : e.target.value; state.audit.page = 1; loadAuditLog(); });
}

function renderEntriesPagination() {
  const el = document.getElementById('entriesPagination');
  if (!el) return;
  const { page, totalPages, entriesTotal, pageSize, entries } = state;
  const from = entriesTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, entriesTotal);

  // Build window of page numbers around current page
  const pages = [];
  const window_ = 2;
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || (p >= page - window_ && p <= page + window_)) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }

  const btn = (label, p, disabled = false, active = false) => `
    <button ${disabled ? 'disabled' : ''} ${p != null && !disabled && !active ? `onclick="goToPage(${p})"` : ''}
      class="px-3 py-1.5 text-sm rounded-lg border ${active ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-200 text-slate-700 hover:bg-slate-50'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}">
      ${label}
    </button>`;

  el.innerHTML = `
    <div class="flex items-center gap-3 text-xs text-slate-500">
      <span>Showing <strong class="text-slate-700">${from}–${to}</strong> of <strong class="text-slate-700">${entriesTotal}</strong></span>
      <select onchange="changePageSize(this.value)" class="px-2 py-1 border border-slate-200 rounded-lg bg-white text-xs">
        ${[25, 50, 100, 200].map(s => `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s}/page</option>`).join('')}
      </select>
    </div>
    <div class="flex items-center gap-1">
      ${btn('‹', page - 1, page <= 1)}
      ${pages.map(p => p === '…' ? '<span class="px-2 text-slate-400">…</span>' : btn(p, p, false, p === page)).join('')}
      ${btn('›', page + 1, page >= totalPages)}
    </div>
  `;
}

// ========== Personnel ==========
function renderPersonnel() {
  const grid = document.getElementById('personnelGrid');
  if (!state.personnel.length) {
    grid.innerHTML = `<div class="col-span-full stat-card text-center py-12">
      <i data-lucide="users" class="w-10 h-10 mx-auto mb-3 text-slate-300"></i>
      <p class="text-slate-500">No personnel yet. Click <strong>Add Personnel</strong> to get started.</p>
    </div>`;
    return;
  }
  const loginUrl = window.location.origin + '/';
  grid.innerHTML = state.personnel.map(p => {
    const init = p.full_name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return `
      <div class="stat-card">
        <div class="flex items-start gap-3 mb-4">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white font-bold shrink-0">${escapeHtml(init)}</div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-slate-900 truncate">${escapeHtml(p.full_name)}</div>
            <div class="text-xs text-slate-500 font-mono truncate">@${escapeHtml(p.username)}</div>
            <div class="mt-1.5">
              ${p.active
                ? '<span class="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full"><span class="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>Active</span>'
                : '<span class="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded-full">Inactive</span>'}
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 mb-4 pt-4 border-t border-slate-100">
          <div>
            <div class="text-xs text-slate-500">Total Commission</div>
            <div class="text-sm font-semibold text-slate-900">${fmtMoney(p.total_commission)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">Paid</div>
            <div class="text-sm font-semibold text-emerald-600">${fmtMoney(p.total_paid)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">Pending</div>
            <div class="text-sm font-semibold text-amber-600">${fmtMoney(p.total_pending)}</div>
          </div>
          <div>
            <div class="text-xs text-slate-500">Entries</div>
            <div class="text-sm font-semibold text-slate-900">${fmtInt(p.entry_count)}</div>
          </div>
        </div>
        <div class="mb-3">
          <label class="text-xs text-slate-500 block mb-1">Default Rate</label>
          <select onchange="updatePersonnelRate(${p.id}, this.value)" class="w-full px-2 py-1.5 border border-slate-300 rounded-lg text-sm bg-white">
            <option value="70" ${p.default_commission_rate === 70 ? 'selected' : ''}>70%</option>
            <option value="30" ${p.default_commission_rate === 30 ? 'selected' : ''}>30%</option>
          </select>
        </div>
        <div class="flex flex-wrap gap-2">
          <button onclick="copyLoginLink('${escapeAttr(loginUrl)}', '${escapeAttr(p.username)}')" class="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1.5 rounded-md">
            <i data-lucide="copy" class="w-3 h-3"></i> Copy Login
          </button>
          <button onclick="resetPassword(${p.id}, '${escapeAttr(p.full_name)}')" class="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md">
            <i data-lucide="key" class="w-3 h-3"></i> Reset Password
          </button>
          <button onclick="togglePersonnelActive(${p.id}, ${p.active ? 0 : 1})" class="inline-flex items-center gap-1 text-xs font-medium ${p.active ? 'text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100' : 'text-emerald-600 hover:text-emerald-700 bg-emerald-50 hover:bg-emerald-100'} px-2.5 py-1.5 rounded-md">
            <i data-lucide="${p.active ? 'user-x' : 'user-check'}" class="w-3 h-3"></i> ${p.active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ========== Drive links ==========
function renderDriveLinks() {
  const container = document.getElementById('driveLinks');
  if (!state.driveLinks.length) {
    container.innerHTML = `<div class="col-span-full stat-card text-center py-12">
      <i data-lucide="folder-open" class="w-10 h-10 mx-auto mb-3 text-slate-300"></i>
      <p class="text-slate-500">No drive links yet. Click <strong>Add Link</strong> to save one.</p>
    </div>`;
    return;
  }
  container.innerHTML = state.driveLinks.map(l => `
    <div class="stat-card group">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><i data-lucide="folder" class="w-5 h-5"></i></div>
        <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener" class="flex-1 min-w-0">
          <div class="font-semibold text-slate-900 group-hover:text-indigo-600 truncate">${escapeHtml(l.title)}</div>
          ${l.description ? `<div class="text-sm text-slate-600 mt-1 line-clamp-2">${escapeHtml(l.description)}</div>` : ''}
          <div class="text-xs text-slate-400 mt-2 truncate">${escapeHtml(l.url)}</div>
        </a>
      </div>
      <div class="flex justify-end gap-1 mt-3 pt-3 border-t border-slate-100">
        <button onclick="editDriveLink(${l.id})" class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded"><i data-lucide="pencil" class="w-4 h-4"></i></button>
        <button onclick="deleteDriveLink(${l.id})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>
    </div>
  `).join('');
}

// ========== Reports ==========
async function loadReports() {
  try {
    const period = document.getElementById('reportPeriod').value;
    const rows = await API.fetch(`/api/admin/reports?period=${period}`);
    const tbody = document.getElementById('reportsBody');
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="px-4 py-10 text-center text-slate-500">
        <i data-lucide="bar-chart-3" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
        No data yet.
      </td></tr>`;
      if (charts.report) { charts.report.destroy(); charts.report = null; }
      refreshIcons();
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const label = period === 'weekly' ? fmtDate(r.period) : r.period;
      return `
        <tr>
          <td class="px-4 py-3 font-medium">${label}</td>
          <td class="px-4 py-3 text-right">${fmtInt(r.entry_count)}</td>
          <td class="px-4 py-3 text-right">${fmtMoney(r.total_sales)}</td>
          <td class="px-4 py-3 text-right font-semibold">${fmtMoney(r.total_commission)}</td>
          <td class="px-4 py-3 text-right text-emerald-600">${fmtMoney(r.paid_commission)}</td>
          <td class="px-4 py-3 text-right text-amber-600">${fmtMoney(r.pending_commission)}</td>
          <td class="px-4 py-3 text-right text-rose-600">${fmtMoney(r.unpaid_commission)}</td>
        </tr>
      `;
    }).join('');
    renderReportChart(rows, period);
    refreshIcons();
  } catch (e) { toast(e.message, 'error'); }
}

function renderReportChart(rows, period) {
  const ctx = document.getElementById('reportChart');
  if (!ctx) return;
  const ordered = [...rows].reverse();
  const labels = ordered.map(r => period === 'weekly' ? fmtDateShort(r.period) : r.period);
  if (charts.report) charts.report.destroy();
  charts.report = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Paid', data: ordered.map(r => r.paid_commission), backgroundColor: '#10b981', borderRadius: 4 },
        { label: 'Pending', data: ordered.map(r => r.pending_commission), backgroundColor: '#f59e0b', borderRadius: 4 },
        { label: 'Unpaid', data: ordered.map(r => r.unpaid_commission), backgroundColor: '#f43f5e', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtMoney(c.parsed.y)}` } }
      },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => fmtMoney(v, { compact: true }) }, grid: { color: '#f1f5f9' } }
      }
    }
  });
}

function exportEntriesCsv() {
  const q = new URLSearchParams();
  Object.entries(state.filters).forEach(([k, v]) => { if (v) q.set(k, v); });
  const token = API.token();
  fetch('/api/admin/reports/export?' + q.toString(), { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.blob())
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `commission-report-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast('CSV downloaded', 'success');
    })
    .catch(e => toast(e.message, 'error'));
}

// ========== Modals & actions ==========
function setupModals() {
  // generic close handlers
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('[id$="Modal"]');
      if (modal) closeModal(modal);
    });
  });

  // edit entry
  const editModal = document.getElementById('editEntryModal');
  const editForm = document.getElementById('editEntryForm');
  editForm.querySelectorAll('input[name="commission_rate"]').forEach(r => r.addEventListener('change', updateEditPreview));
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(editForm);
    const body = Object.fromEntries(fd);
    const id = body.id; delete body.id;
    body.commission_rate = parseInt(body.commission_rate);
    try {
      await API.fetch(`/api/admin/entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeModal(editModal);
      toast('Entry updated', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  // admin new entry
  const newEntryModal = document.getElementById('newAdminEntryModal');
  const newEntryForm = document.getElementById('newAdminEntryForm');
  document.getElementById('newAdminEntryBtn').addEventListener('click', () => {
    newEntryForm.reset();
    newEntryForm.querySelector('input[name="commission_rate"][value="70"]').checked = true;
    newEntryForm.sale_date.value = new Date().toISOString().slice(0, 10);
    // reset PDF auto-fill UI
    const status = document.getElementById('adminPdfStatus');
    const ex = document.getElementById('adminPdfExtracted');
    const hint = document.getElementById('personnelMatchHint');
    if (status) { status.classList.add('hidden'); status.innerHTML = ''; }
    if (ex) { ex.classList.add('hidden'); ex.innerHTML = ''; }
    if (hint) hint.classList.add('hidden');
    openModal(newEntryModal);
    refreshIcons();
  });
  newEntryForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(newEntryForm);
    const body = Object.fromEntries(fd);
    body.commission_rate = parseInt(body.commission_rate);
    body.personnel_id = parseInt(body.personnel_id);
    try {
      await API.fetch('/api/admin/entries', { method: 'POST', body: JSON.stringify(body) });
      closeModal(newEntryModal);
      toast('Entry created', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  // personnel
  const pModal = document.getElementById('newPersonnelModal');
  const pForm = document.getElementById('newPersonnelForm');
  document.getElementById('newPersonnelBtn').addEventListener('click', () => { pForm.reset(); pForm.querySelector('input[value="70"]').checked = true; openModal(pModal); refreshIcons(); });
  pForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(pForm);
    const body = Object.fromEntries(fd);
    body.default_commission_rate = parseInt(body.default_commission_rate);
    try {
      await API.fetch('/api/admin/personnel', { method: 'POST', body: JSON.stringify(body) });
      closeModal(pModal);
      toast('Personnel created', 'success');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  // transfer (single + bulk)
  const transferModal = document.getElementById('transferModal');
  const transferForm = document.getElementById('transferForm');
  transferForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(transferForm);
    const body = Object.fromEntries(fd);
    const mode = body.mode;
    const note = (body.note || '').trim();
    if (!note) { toast('Please provide a reason', 'warn'); return; }
    try {
      if (mode === 'single') {
        await API.fetch(`/api/admin/entries/${body.id}/transfer`, {
          method: 'POST', body: JSON.stringify({ note })
        });
        toast('Entry moved to next cycle', 'success');
      } else {
        const r = await API.fetch('/api/admin/transfer-unpaid', {
          method: 'POST', body: JSON.stringify({ cycle: body.cycle, note })
        });
        toast(`${r.moved} ${r.moved === 1 ? 'entry' : 'entries'} moved to ${fmtDate(r.nextCycle)}`, 'success');
      }
      closeModal(transferModal);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  // drive link
  const dModal = document.getElementById('driveLinkModal');
  const dForm = document.getElementById('driveLinkForm');
  document.getElementById('newDriveLinkBtn').addEventListener('click', () => {
    dForm.reset();
    dForm.id.value = '';
    document.getElementById('driveLinkTitle').textContent = 'Add Drive Link';
    openModal(dModal);
    refreshIcons();
  });
  dForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(dForm);
    const body = Object.fromEntries(fd);
    const id = body.id; delete body.id;
    try {
      if (id) {
        await API.fetch(`/api/admin/drive-links/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast('Drive link updated', 'success');
      } else {
        await API.fetch('/api/admin/drive-links', { method: 'POST', body: JSON.stringify(body) });
        toast('Drive link added', 'success');
      }
      closeModal(dModal);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function updateEditPreview() {
  const form = document.getElementById('editEntryForm');
  const e = state.entries.find(x => x.id === parseInt(form.id.value));
  if (!e) return;
  const rate = parseInt(form.querySelector('input[name="commission_rate"]:checked')?.value || e.commission_rate);
  const computed = (e.sale_amount * rate) / 100;
  document.getElementById('editRatePreview').textContent = `Computed commission: ${fmtMoney(computed)} (sale ${fmtMoney(e.sale_amount)} × ${rate}%)`;
}

window.openEdit = async function(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const modal = document.getElementById('editEntryModal');
  const form = document.getElementById('editEntryForm');
  form.id.value = e.id;
  const rateInput = form.querySelector(`input[name="commission_rate"][value="${e.commission_rate}"]`);
  if (rateInput) rateInput.checked = true;
  form.status.value = e.status;
  form.notes.value = e.notes || '';
  document.getElementById('editEntryInfo').innerHTML = `
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <div><span class="text-slate-500">Personnel:</span> <span class="font-medium text-slate-800">${escapeHtml(e.personnel_name)}</span></div>
      <div><span class="text-slate-500">Date:</span> <span class="font-medium text-slate-800">${fmtDate(e.sale_date)}</span></div>
      <div class="col-span-2"><span class="text-slate-500">Description:</span> <span class="font-medium text-slate-800">${escapeHtml(e.description)}</span></div>
      <div><span class="text-slate-500">Sale:</span> <span class="font-medium text-slate-800">${fmtMoney(e.sale_amount)}</span></div>
      <div><span class="text-slate-500">Current cycle:</span> <span class="font-medium text-slate-800">${fmtDate(e.billing_cycle_date)}</span></div>
      ${e.customer_name ? `<div class="col-span-2"><span class="text-slate-500">Customer:</span> <span class="font-medium text-slate-800">${escapeHtml(e.customer_name)}</span></div>` : ''}
      ${e.drive_link ? `<div class="col-span-2"><a href="${escapeAttr(e.drive_link)}" target="_blank" rel="noopener" class="text-indigo-600 hover:underline inline-flex items-center gap-1"><i data-lucide="external-link" class="w-3 h-3"></i>View verification link</a></div>` : ''}
    </div>
  `;
  document.getElementById('editEntryBreakdown').innerHTML = renderAdminBreakdown(e);
  document.getElementById('editEntryAttachments').innerHTML = `
    <div class="text-sm text-slate-500 flex items-center gap-2"><i data-lucide="paperclip" class="w-4 h-4"></i>Loading attachments...</div>
  `;
  updateEditPreview();
  openModal(modal);
  refreshIcons();

  try {
    const atts = await listAttachments(e.id);
    renderAdminAttachments(atts);
  } catch (err) {
    document.getElementById('editEntryAttachments').innerHTML =
      `<div class="text-sm text-rose-600">Failed to load attachments: ${escapeHtml(err.message)}</div>`;
  }
};

function renderAdminAttachments(atts) {
  const el = document.getElementById('editEntryAttachments');
  if (!atts.length) {
    el.innerHTML = `<div class="text-sm text-slate-400 flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg">
      <i data-lucide="paperclip" class="w-4 h-4"></i>No attachments uploaded
    </div>`;
    refreshIcons();
    return;
  }
  el.innerHTML = `
    <div class="flex items-center gap-2 mb-2 text-sm font-medium text-slate-700">
      <i data-lucide="paperclip" class="w-4 h-4"></i>Attachments (${atts.length})
    </div>
    <div class="grid grid-cols-2 gap-2">
      ${atts.map(a => `
        <button type="button" onclick="openAttachmentModal(${a.id})" class="flex items-center gap-2 p-2 border border-slate-200 rounded-lg bg-white hover:border-indigo-300 hover:bg-indigo-50/30 text-left transition">
          <div id="thumb-${a.id}" class="w-10 h-10 rounded ${isImageMime(a.mime_type) ? 'skeleton' : 'bg-slate-100'} flex items-center justify-center shrink-0">
            ${!isImageMime(a.mime_type) ? attachmentIconHtml(a.mime_type) : ''}
          </div>
          <div class="flex-1 min-w-0">
            <div class="text-xs font-medium text-slate-800 truncate">${escapeHtml(a.original_name)}</div>
            <div class="text-xs text-slate-500">${fmtBytes(a.size)}</div>
          </div>
        </button>
      `).join('')}
    </div>
  `;
  loadThumbnails(atts);
  refreshIcons();
}

function openTransferModal(opts) {
  const modal = document.getElementById('transferModal');
  const form = document.getElementById('transferForm');
  const info = document.getElementById('transferInfo');
  form.reset();
  form.mode.value = opts.mode;
  form.id.value = '';
  form.cycle.value = '';

  if (opts.mode === 'single') {
    const e = opts.entry;
    form.id.value = e.id;
    const to = nextFridayAfter(e.billing_cycle_date);
    document.getElementById('transferTitle').textContent = 'Move Entry to Next Cycle';
    info.innerHTML = `
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <span class="text-slate-500">Personnel</span><span class="font-medium text-slate-800">${escapeHtml(e.personnel_name)}</span>
        <span class="text-slate-500">Description</span><span class="font-medium text-slate-800 truncate">${escapeHtml(e.description)}</span>
        <span class="text-slate-500">Commission</span><span class="font-medium text-slate-800">${fmtMoney(e.commission_amount)}</span>
        <span class="text-slate-500">From cycle</span><span class="font-medium text-slate-800">${fmtDate(e.billing_cycle_date)}</span>
        <span class="text-slate-500">Moving to</span><span class="font-semibold text-amber-700">${fmtDate(to)}</span>
      </div>
    `;
  } else {
    form.cycle.value = opts.cycle;
    const to = nextFridayAfter(opts.cycle);
    document.getElementById('transferTitle').textContent = `Move ${opts.count} Non-paid ${opts.count === 1 ? 'Entry' : 'Entries'}`;
    info.innerHTML = `
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <span class="text-slate-500">Current cycle</span><span class="font-medium text-slate-800">${fmtDate(opts.cycle)}</span>
        <span class="text-slate-500">Entries to move</span><span class="font-medium text-slate-800">${opts.count} (non-paid only)</span>
        <span class="text-slate-500">Moving to</span><span class="font-semibold text-amber-700">${fmtDate(to)}</span>
      </div>
      <div class="text-xs text-amber-700 mt-2">The same reason will be applied to every affected entry.</div>
    `;
  }
  openModal(modal);
  refreshIcons();
  setTimeout(() => form.note.focus(), 50);
}

window.transferEntry = function(id) {
  const entry = state.entries.find(x => x.id === id);
  if (!entry) return;
  openTransferModal({ mode: 'single', entry });
};

window.deleteEntry = async function(id) {
  const ok = await confirmDialog({ title: 'Delete entry?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await API.fetch(`/api/admin/entries/${id}`, { method: 'DELETE' });
    toast('Entry deleted', 'success');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
};

function transferAllUnpaid() {
  const cycle = state.stats?.currentCycle || getCurrentCycleFriday();
  const count = state.entries.filter(e => e.billing_cycle_date === cycle && e.status !== 'paid').length;
  if (count === 0) { toast('No non-paid entries in current cycle', 'info'); return; }
  openTransferModal({ mode: 'bulk', cycle, count });
}

window.updatePersonnelRate = async function(id, rate) {
  try {
    await API.fetch(`/api/admin/personnel/${id}`, { method: 'PATCH', body: JSON.stringify({ default_commission_rate: parseInt(rate) }) });
    toast('Default rate updated', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

window.togglePersonnelActive = async function(id, active) {
  try {
    await API.fetch(`/api/admin/personnel/${id}`, { method: 'PATCH', body: JSON.stringify({ active: !!active }) });
    toast(active ? 'Personnel activated' : 'Personnel deactivated', 'success');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
};

window.resetPassword = async function(id, name) {
  const pw = await promptDialog({
    title: `Reset password for ${name}`,
    message: 'Enter a new password (min 4 characters).',
    placeholder: 'New password',
    confirmText: 'Reset'
  });
  if (!pw || pw.length < 4) { if (pw !== null) toast('Password too short', 'warn'); return; }
  try {
    await API.fetch(`/api/admin/personnel/${id}`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
    toast('Password reset', 'success');
  } catch (e) { toast(e.message, 'error'); }
};

window.copyLoginLink = function(url, username) {
  const text = `Login: ${url}\nUsername: ${username}\nPassword: (sent separately)`;
  navigator.clipboard.writeText(text)
    .then(() => toast('Login info copied to clipboard', 'success'))
    .catch(() => promptDialog({ title: 'Copy login info', initialValue: text, confirmText: 'Done' }));
};

window.editDriveLink = function(id) {
  const l = state.driveLinks.find(x => x.id === id);
  if (!l) return;
  const modal = document.getElementById('driveLinkModal');
  const form = document.getElementById('driveLinkForm');
  form.id.value = l.id;
  form.title.value = l.title;
  form.url.value = l.url;
  form.description.value = l.description || '';
  document.getElementById('driveLinkTitle').textContent = 'Edit Drive Link';
  openModal(modal);
  refreshIcons();
};

window.deleteDriveLink = async function(id) {
  const ok = await confirmDialog({ title: 'Delete drive link?', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await API.fetch(`/api/admin/drive-links/${id}`, { method: 'DELETE' });
    toast('Drive link deleted', 'success');
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
};

async function handleChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  try {
    await API.fetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) });
    form.reset();
    toast('Password updated', 'success');
  } catch (err) { toast(err.message, 'error'); }
}


// ============================================================
// PDF AUTO-FILL: Admin "Add Entry" modal
// ============================================================
function setupAdminPdfAutofill() {
  const input = document.getElementById('adminPdfInput');
  const dropzone = document.getElementById('adminPdfDropzone');
  if (!input || !dropzone) return;

  input.addEventListener('change', (e) => handleAdminPdf(e.target.files[0]));
  setupDropzoneArea(dropzone, (files) => {
    const pdf = files.find(f => f.type === 'application/pdf');
    if (pdf) handleAdminPdf(pdf);
    else toast('Please drop a PDF', 'warn');
  });
}

function setupDropzoneArea(el, onFiles) {
  ['dragenter', 'dragover'].forEach(evt => el.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.add('border-indigo-500', 'bg-indigo-50');
  }));
  ['dragleave', 'drop'].forEach(evt => el.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('border-indigo-500', 'bg-indigo-50');
  }));
  el.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });
}

async function extractPdf(file) {
  if (!file) throw new Error('No file');
  if (file.type !== 'application/pdf') throw new Error('Please upload a PDF');
  if (file.size > 10 * 1024 * 1024) throw new Error('PDF too large (max 10MB)');
  const fd = new FormData();
  fd.append('pdf', file);
  const res = await fetch('/api/personnel/extract-pdf', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + API.token() },
    body: fd
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'Could not read this PDF');
  }
  return res.json();
}

async function handleAdminPdf(file) {
  if (!file) return;
  const status = document.getElementById('adminPdfStatus');
  status.classList.remove('hidden', 'text-rose-600', 'text-emerald-600');
  status.classList.add('text-slate-600');
  status.innerHTML = `<div class="inline-flex items-center gap-2"><div class="w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin"></div>Reading "${escapeHtml(file.name)}"...</div>`;

  try {
    const result = await extractPdf(file);
    const f = result.fields || {};
    const found = Object.keys(f).filter(k => k !== 'confidence');

    const form = document.getElementById('newAdminEntryForm');
    if (f.sale_date) form.sale_date.value = f.sale_date;
    if (f.sale_amount) form.sale_amount.value = f.sale_amount;
    if (f.description) form.description.value = f.description;
    if (f.customer_name && form.customer_name) form.customer_name.value = f.customer_name;
    if (f.notes && form.notes) form.notes.value = f.notes;

    const hint = document.getElementById('personnelMatchHint');
    if (f.salesperson_name) {
      const match = bestPersonnelMatch(state.personnel.filter(p => p.active), f.salesperson_name);
      if (match) {
        form.personnel_id.value = String(match.user.id);
        hint.textContent = `Matched "${f.salesperson_name}" → ${match.user.full_name} (${Math.round(match.score * 100)}% confidence)`;
        hint.className = 'text-xs text-emerald-700 mt-1';
        hint.classList.remove('hidden');
      } else {
        hint.textContent = `Couldn't match "${f.salesperson_name}" to any personnel — please pick manually`;
        hint.className = 'text-xs text-amber-700 mt-1';
        hint.classList.remove('hidden');
      }
    } else {
      hint.classList.add('hidden');
    }

    const ex = document.getElementById('adminPdfExtracted');
    ex.innerHTML = renderExtractedPanel(f, found.length);
    ex.classList.remove('hidden');

    status.classList.remove('text-slate-600');
    status.classList.add('text-emerald-600');
    status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="check-circle-2" class="w-4 h-4"></i>Filled ${found.length} field${found.length === 1 ? '' : 's'} from PDF</div>`;
    refreshIcons();
  } catch (e) {
    status.classList.remove('text-slate-600', 'text-emerald-600');
    status.classList.add('text-rose-600');
    status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="alert-circle" class="w-4 h-4"></i>${escapeHtml(e.message)}</div>`;
    refreshIcons();
  }
}

function renderExtractedPanel(f, foundCount) {
  if (!foundCount) return '';
  const conf = f.confidence || {};
  const fields = [
    { key: 'sale_amount',      label: 'Amount',       value: f.sale_amount != null ? fmtMoney(f.sale_amount) : null,     icon: 'dollar-sign' },
    { key: 'salesperson_name', label: 'Commissioner', value: f.salesperson_name ? escapeHtml(f.salesperson_name) : null, icon: 'user-check' },
    { key: 'customer_name',    label: 'Customer',     value: f.customer_name ? escapeHtml(f.customer_name) : null,       icon: 'user' },
    { key: 'sale_date',        label: 'Date',         value: f.sale_date ? fmtDate(f.sale_date) : null,                  icon: 'calendar' },
    { key: 'description',      label: 'Item',         value: f.description ? escapeHtml(f.description) : null,           icon: 'package' }
  ].filter(x => x.value);
  return `
    <div class="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 mb-3">
      <div class="flex items-center gap-2 mb-2">
        <i data-lucide="sparkles" class="w-4 h-4 text-emerald-700"></i>
        <div class="text-xs font-semibold text-emerald-900">Extracted from PDF</div>
      </div>
      <div class="grid grid-cols-2 gap-1.5 text-xs">
        ${fields.map(x => `
          <div class="bg-white rounded px-2 py-1.5 border border-emerald-100">
            <div class="text-slate-500 flex items-center gap-1"><i data-lucide="${x.icon}" class="w-3 h-3"></i>${x.label}
              ${conf[x.key] ? `<span class="ml-auto text-[10px] uppercase px-1 rounded ${conf[x.key] === 'high' ? 'bg-emerald-100 text-emerald-700' : conf[x.key] === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}">${conf[x.key]}</span>` : ''}
            </div>
            <div class="font-medium text-slate-900 truncate">${x.value}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ============================================================
// CROSS-CHECK: Verify modal — compare submitted vs PDF
// ============================================================
let crossCheckEntryId = null;

function setupCrossCheck() {
  const input = document.getElementById('crossCheckInput');
  const dropzone = document.getElementById('crossCheckDropzone');
  if (!input || !dropzone) return;
  input.addEventListener('change', (e) => handleCrossCheck(e.target.files[0]));
  setupDropzoneArea(dropzone, (files) => {
    const pdf = files.find(f => f.type === 'application/pdf');
    if (pdf) handleCrossCheck(pdf);
    else toast('Please drop a PDF', 'warn');
  });
}

async function handleCrossCheck(file) {
  if (!file) return;
  const entryId = document.getElementById('editEntryForm')?.id?.value;
  const entry = state.entries.find(e => e.id === parseInt(entryId));
  if (!entry) { toast('No entry loaded', 'error'); return; }
  crossCheckEntryId = entry.id;

  const status = document.getElementById('crossCheckStatus');
  const result = document.getElementById('crossCheckResult');
  status.classList.remove('hidden', 'text-rose-600');
  status.classList.add('text-slate-600');
  status.innerHTML = `<div class="inline-flex items-center gap-2"><div class="w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin"></div>Reading PDF and comparing...</div>`;
  result.innerHTML = '';

  try {
    const extracted = await extractPdf(file);
    const f = extracted.fields || {};
    const personnel = state.personnel.find(p => p.id === entry.personnel_id);

    const rows = [
      compareField('Personnel', personnel?.full_name, f.salesperson_name, 'name'),
      compareField('Sale amount', entry.sale_amount, f.sale_amount, 'money'),
      compareField('Customer', entry.customer_name, f.customer_name, 'name'),
      compareField('Sale date', entry.sale_date, f.sale_date, 'date'),
      compareField('Description', entry.description, f.description, 'text')
    ];

    const mismatches = rows.filter(r => r.status === 'mismatch').length;
    const okCount = rows.filter(r => r.status === 'match').length;

    status.classList.remove('text-slate-600');
    status.classList.add(mismatches ? 'text-amber-700' : 'text-emerald-700');
    status.innerHTML = mismatches
      ? `<div class="inline-flex items-center gap-2"><i data-lucide="alert-triangle" class="w-4 h-4"></i>${mismatches} mismatch${mismatches === 1 ? '' : 'es'} · ${okCount} match${okCount === 1 ? '' : 'es'}</div>`
      : `<div class="inline-flex items-center gap-2"><i data-lucide="check-circle-2" class="w-4 h-4"></i>Everything checks out (${okCount} match${okCount === 1 ? '' : 'es'})</div>`;

    result.innerHTML = `
      <div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <table class="w-full text-xs">
          <thead class="bg-slate-50 text-slate-500 uppercase">
            <tr>
              <th class="px-3 py-2 text-left">Field</th>
              <th class="px-3 py-2 text-left">Submitted</th>
              <th class="px-3 py-2 text-left">From PDF</th>
              <th class="px-3 py-2 text-center">Match</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${rows.map(r => `
              <tr class="${r.status === 'mismatch' ? 'bg-amber-50/50' : ''}">
                <td class="px-3 py-2 font-medium text-slate-700">${r.label}</td>
                <td class="px-3 py-2 text-slate-700">${r.submittedDisplay || '<span class="text-slate-300">—</span>'}</td>
                <td class="px-3 py-2 text-slate-700">${r.pdfDisplay || '<span class="text-slate-300">—</span>'}</td>
                <td class="px-3 py-2 text-center">${
                  r.status === 'match' ? '<i data-lucide="check-circle-2" class="w-4 h-4 text-emerald-600 inline"></i>'
                  : r.status === 'mismatch' ? '<i data-lucide="x-circle" class="w-4 h-4 text-rose-600 inline"></i>'
                  : '<span class="text-slate-300">—</span>'
                }</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${mismatches ? `
        <div class="flex justify-end mt-2">
          <button type="button" onclick="applyCrossCheckValues()" class="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg inline-flex items-center gap-1">
            <i data-lucide="copy-check" class="w-3.5 h-3.5"></i> Apply PDF values to entry
          </button>
        </div>
      ` : ''}
    `;
    window._crossCheckExtracted = f;
    refreshIcons();
  } catch (e) {
    status.classList.remove('text-slate-600');
    status.classList.add('text-rose-600');
    status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="alert-circle" class="w-4 h-4"></i>${escapeHtml(e.message)}</div>`;
    refreshIcons();
  }
}

function compareField(label, submitted, pdfValue, type) {
  const both = submitted != null && submitted !== '' && pdfValue != null && pdfValue !== '';
  const row = { label, submitted, pdfValue, status: 'unknown' };
  if (type === 'money') {
    row.submittedDisplay = submitted != null ? fmtMoney(submitted) : '';
    row.pdfDisplay = pdfValue != null ? fmtMoney(pdfValue) : '';
    if (both) row.status = moneyClose(submitted, pdfValue) ? 'match' : 'mismatch';
  } else if (type === 'date') {
    row.submittedDisplay = submitted ? fmtDate(submitted) : '';
    row.pdfDisplay = pdfValue ? fmtDate(pdfValue) : '';
    if (both) row.status = dateEqual(submitted, pdfValue) ? 'match' : 'mismatch';
  } else if (type === 'name') {
    row.submittedDisplay = escapeHtml(submitted || '');
    row.pdfDisplay = escapeHtml(pdfValue || '');
    if (both) row.status = nameSimilarity(submitted, pdfValue) >= 0.7 ? 'match' : 'mismatch';
  } else {
    row.submittedDisplay = escapeHtml(submitted || '');
    row.pdfDisplay = escapeHtml(pdfValue || '');
    if (both) {
      const a = String(submitted).toLowerCase().trim();
      const b = String(pdfValue).toLowerCase().trim();
      row.status = (a === b || a.includes(b) || b.includes(a)) ? 'match' : 'mismatch';
    }
  }
  return row;
}

window.applyCrossCheckValues = async function () {
  const f = window._crossCheckExtracted;
  if (!f || !crossCheckEntryId) return;
  const ok = await confirmDialog({
    title: 'Apply PDF values to this entry?',
    message: 'The submitted values will be overwritten with what the PDF says.',
    confirmText: 'Apply'
  });
  if (!ok) return;
  const body = {};
  if (f.sale_amount != null) body.sale_amount = f.sale_amount;
  if (f.sale_date) body.sale_date = f.sale_date;
  if (f.customer_name) body.customer_name = f.customer_name;
  if (f.description) body.description = f.description;
  try {
    await API.fetch(`/api/admin/entries/${crossCheckEntryId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast('Entry updated to match PDF', 'success');
    closeModal(document.getElementById('editEntryModal'));
    await refresh();
  } catch (e) { toast(e.message, 'error'); }
};

// ============================================================
// BULK IMPORT: drop many PDFs, review, create all
// ============================================================
const bulkState = { items: [] };

function setupBulkImport() {
  const input = document.getElementById('bulkPdfInput');
  const dropzone = document.getElementById('bulkPdfDropzone');
  if (!input || !dropzone) return;

  input.addEventListener('change', (e) => {
    handleBulkFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });
  setupDropzoneArea(dropzone, (files) => {
    handleBulkFiles(files.filter(f => f.type === 'application/pdf'));
  });

  document.getElementById('bulkPdfClearBtn').addEventListener('click', () => {
    bulkState.items = [];
    renderBulkList();
  });
  document.getElementById('bulkPdfCreateBtn').addEventListener('click', bulkCreateAll);
}

async function handleBulkFiles(files) {
  if (!files.length) return;
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { toast(`"${file.name}" too large (max 10MB)`, 'warn'); continue; }
    const id = Math.random().toString(36).slice(2, 9);
    const item = { id, file, status: 'extracting', fields: null, error: null, personnelId: '', rate: 70 };
    bulkState.items.push(item);
    renderBulkList();
    extractPdf(file)
      .then((res) => {
        item.fields = res.fields || {};
        const match = item.fields.salesperson_name
          ? bestPersonnelMatch(state.personnel.filter(p => p.active), item.fields.salesperson_name)
          : null;
        if (match) {
          item.personnelId = match.user.id;
          item.rate = match.user.default_commission_rate || 70;
          item.matchScore = match.score;
        }
        item.status = 'ready';
        renderBulkList();
      })
      .catch((e) => {
        item.error = e.message;
        item.status = 'error';
        renderBulkList();
      });
  }
}

function renderBulkList() {
  const list = document.getElementById('bulkPdfList');
  const empty = document.getElementById('bulkPdfEmpty');
  const toolbar = document.getElementById('bulkPdfToolbar');
  if (!bulkState.items.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    toolbar.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  toolbar.classList.remove('hidden');
  document.getElementById('bulkPdfCount').textContent = bulkState.items.filter(i => i.status === 'ready').length + ' / ' + bulkState.items.length;

  const personnelOpts = state.personnel.filter(p => p.active).map(p => `<option value="${p.id}">${escapeHtml(p.full_name)}</option>`).join('');

  list.innerHTML = bulkState.items.map(item => {
    if (item.status === 'extracting') {
      return `
        <div class="bg-white border border-slate-200 rounded-xl p-4 flex items-center gap-3">
          <div class="w-5 h-5 border-2 border-slate-300 border-t-indigo-600 rounded-full animate-spin"></div>
          <div class="flex-1 text-sm text-slate-700 truncate">Reading <strong>${escapeHtml(item.file.name)}</strong>...</div>
          <button onclick="removeBulkItem('${item.id}')" class="text-slate-400 hover:text-rose-600"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>`;
    }
    if (item.status === 'error') {
      return `
        <div class="bg-rose-50 border border-rose-200 rounded-xl p-4 flex items-start gap-3">
          <i data-lucide="alert-circle" class="w-5 h-5 text-rose-600 mt-0.5 shrink-0"></i>
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium text-slate-900 truncate">${escapeHtml(item.file.name)}</div>
            <div class="text-xs text-rose-700 mt-1">${escapeHtml(item.error)}</div>
          </div>
          <button onclick="removeBulkItem('${item.id}')" class="text-slate-400 hover:text-rose-600"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>`;
    }
    if (item.status === 'created') {
      return `
        <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3">
          <i data-lucide="check-circle-2" class="w-5 h-5 text-emerald-600"></i>
          <div class="flex-1 text-sm text-slate-700 truncate">Created entry <strong>#${item.createdId}</strong> from ${escapeHtml(item.file.name)}</div>
        </div>`;
    }
    const f = item.fields || {};
    const personnelOptsSelected = state.personnel.filter(p => p.active)
      .map(p => `<option value="${p.id}" ${String(item.personnelId) === String(p.id) ? 'selected' : ''}>${escapeHtml(p.full_name)}</option>`).join('');
    return `
      <div class="bg-white border border-slate-200 rounded-xl p-4">
        <div class="flex items-center justify-between mb-3 gap-3">
          <div class="flex items-center gap-2 min-w-0">
            <i data-lucide="file-text" class="w-4 h-4 text-rose-600 shrink-0"></i>
            <div class="font-medium text-slate-900 truncate">${escapeHtml(item.file.name)}</div>
          </div>
          <button onclick="removeBulkItem('${item.id}')" class="text-slate-400 hover:text-rose-600 shrink-0"><i data-lucide="x" class="w-4 h-4"></i></button>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          <div>
            <label class="text-xs text-slate-500">Personnel</label>
            <select onchange="updateBulkItem('${item.id}','personnelId',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
              <option value="">Select...</option>${personnelOptsSelected}
            </select>
            ${f.salesperson_name ? `<div class="text-xs ${item.matchScore >= 0.7 ? 'text-emerald-700' : 'text-amber-700'} mt-1">PDF says "${escapeHtml(f.salesperson_name)}"${item.matchScore ? ` (${Math.round(item.matchScore * 100)}% match)` : ''}</div>` : ''}
          </div>
          <div>
            <label class="text-xs text-slate-500">Rate</label>
            <select onchange="updateBulkItem('${item.id}','rate',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm bg-white">
              <option value="70" ${item.rate == 70 ? 'selected' : ''}>70%</option>
              <option value="30" ${item.rate == 30 ? 'selected' : ''}>30%</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-slate-500">Date</label>
            <input type="date" value="${f.sale_date || ''}" onchange="updateBulkItem('${item.id}','date',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
          <div>
            <label class="text-xs text-slate-500">Sale ($)</label>
            <input type="number" step="0.01" value="${f.sale_amount || ''}" onchange="updateBulkItem('${item.id}','sale',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
          <div class="md:col-span-2">
            <label class="text-xs text-slate-500">Customer</label>
            <input type="text" value="${escapeAttr(f.customer_name || '')}" onchange="updateBulkItem('${item.id}','customer',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
          <div class="md:col-span-2">
            <label class="text-xs text-slate-500">Description</label>
            <input type="text" value="${escapeAttr(f.description || '')}" onchange="updateBulkItem('${item.id}','description',this.value)" class="w-full mt-0.5 px-2 py-1.5 border border-slate-300 rounded text-sm" />
          </div>
        </div>
      </div>
    `;
  }).join('');
  refreshIcons();
}

window.updateBulkItem = function (id, field, value) {
  const item = bulkState.items.find(i => i.id === id);
  if (!item) return;
  if (field === 'personnelId') item.personnelId = value;
  else if (field === 'rate') item.rate = parseInt(value);
  else {
    item.fields = item.fields || {};
    if (field === 'date') item.fields.sale_date = value;
    if (field === 'sale') item.fields.sale_amount = parseFloat(value);
    if (field === 'customer') item.fields.customer_name = value;
    if (field === 'description') item.fields.description = value;
  }
};

window.removeBulkItem = function (id) {
  bulkState.items = bulkState.items.filter(i => i.id !== id);
  renderBulkList();
};

async function bulkCreateAll() {
  const ready = bulkState.items.filter(i => i.status === 'ready');
  if (!ready.length) { toast('Nothing to create', 'warn'); return; }
  const missing = ready.filter(i => !i.personnelId || !i.fields?.sale_amount || !i.fields?.sale_date || !i.fields?.description);
  if (missing.length) {
    toast(`${missing.length} ${missing.length === 1 ? 'PDF is' : 'PDFs are'} missing required fields`, 'warn');
    return;
  }
  const ok = await confirmDialog({
    title: `Create ${ready.length} ${ready.length === 1 ? 'entry' : 'entries'}?`,
    message: 'This will add all of these to the system.',
    confirmText: 'Create all'
  });
  if (!ok) return;

  let created = 0, failed = 0;
  for (const item of ready) {
    try {
      const result = await API.fetch('/api/admin/entries', {
        method: 'POST',
        body: JSON.stringify({
          personnel_id: parseInt(item.personnelId),
          sale_date: item.fields.sale_date,
          description: item.fields.description,
          sale_amount: item.fields.sale_amount,
          commission_rate: item.rate,
          customer_name: item.fields.customer_name || null,
          notes: 'Imported from PDF: ' + item.file.name
        })
      });
      item.status = 'created';
      item.createdId = result.id;
      created++;
    } catch (e) {
      item.status = 'error';
      item.error = e.message;
      failed++;
    }
    renderBulkList();
  }
  toast(`${created} created, ${failed} failed`, failed ? 'warn' : 'success');
  await refresh();
}
