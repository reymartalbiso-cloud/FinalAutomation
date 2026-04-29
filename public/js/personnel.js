const user = requireAuth('personnel');

const state = {
  entries: [],
  driveLinks: [],
  stats: null,
  profile: null,
  paySummary: null
};

const charts = {};

// ========== modal/wizard state ==========
let modalState = {
  entryId: null,
  existing: [],
  queue: [],
  step: 1,
  prefilled: null
};

if (user) {
  document.getElementById('userLabel').textContent = user.full_name;
  document.getElementById('userAvatar').textContent = user.full_name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.getElementById('greetingText').textContent = `Hi, ${user.full_name.split(' ')[0]}!`;
  logoutSetup();
  applyChartDefaults();
  setupTabs((tab) => { if (tab === 'pay') loadPaySummary(); });
  init();
}

async function init() {
  await refresh();
  setupEntryWizard();
  document.getElementById('newEntryBtn').addEventListener('click', () => openEntryModal());
  document.getElementById('dashNewEntryBtn').addEventListener('click', () => openEntryModal());
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  document.getElementById('restartTourBtn')?.addEventListener('click', () => startTour(true));
  refreshIcons();
  // Show first-time tour
  if (!localStorage.getItem('tourSeen')) startTour();
}

async function refresh() {
  try {
    const [entries, driveLinks, stats, profile] = await Promise.all([
      API.fetch('/api/personnel/me/entries'),
      API.fetch('/api/drive-links'),
      API.fetch('/api/personnel/me/stats'),
      API.fetch('/api/auth/me')
    ]);
    state.entries = entries;
    state.driveLinks = driveLinks;
    state.stats = stats;
    state.profile = profile.user;
    renderDashboard();
    renderEntries();
    renderDriveLinks();
    renderProfile();
    refreshIcons();
  } catch (e) { console.error(e); toast(e.message, 'error'); }
}

function renderDashboard() {
  const s = state.stats;
  if (!s) return;
  document.getElementById('currentCycleLabel').textContent = fmtDate(s.currentCycle);
  document.getElementById('statTotalCommission').textContent = fmtMoney(s.totals.totalCommission);
  document.getElementById('statTotalEntries').textContent = fmtInt(s.totals.totalEntries);
  document.getElementById('statCurrentCommission').textContent = fmtMoney(s.currentCycleStats.commission);
  document.getElementById('statCurrentEntries').textContent = fmtInt(s.currentCycleStats.entryCount);
  document.getElementById('statPaid').textContent = fmtMoney(s.totals.totalPaid);
  document.getElementById('statPending').textContent = fmtMoney(s.totals.totalPending);
  renderTrendChart(s.weeklyTrend);
  renderStatusChart(s.statusBreakdown);
  renderCurrentCycleList();
  refreshIcons();
}

function renderTrendChart(data) {
  const ctx = document.getElementById('trendChart');
  if (!ctx) return;
  const labels = data.map(d => fmtDateShort(d.cycle));
  const commission = data.map(d => d.commission);
  if (charts.trend) charts.trend.destroy();
  const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, 'rgba(255, 183, 3, 0.35)');
  gradient.addColorStop(1, 'rgba(11, 37, 69, 0)');
  charts.trend = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [
      { label: 'Commission', data: commission, borderColor: '#0b2545', backgroundColor: gradient, tension: 0.4, fill: true, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#ffb703', pointBorderColor: '#0b2545', pointBorderWidth: 2, borderWidth: 2.5 }
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtMoney(c.parsed.y)}` } } },
      scales: { y: { beginAtZero: true, ticks: { callback: (v) => fmtMoney(v, { compact: true }) }, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } }
    }
  });
}

function renderStatusChart(breakdown) {
  const ctx = document.getElementById('statusChart');
  if (!ctx) return;
  const map = { paid: 0, pending: 0, unpaid: 0 };
  breakdown.forEach(b => map[b.status] = b.amount);
  const total = map.paid + map.pending + map.unpaid;
  if (charts.status) charts.status.destroy();
  if (total === 0) {
    ctx.parentElement.innerHTML = '<div class="text-center text-slate-400 text-sm py-12"><i data-lucide="pie-chart" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>No sales yet</div>';
    refreshIcons();
    return;
  }
  charts.status = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ['Paid', 'Pending', 'Unpaid'], datasets: [{ data: [map.paid, map.pending, map.unpaid], backgroundColor: ['#10b981', '#f59e0b', '#f43f5e'], borderWidth: 0, spacing: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { padding: 12, boxWidth: 8, boxHeight: 8 } }, tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtMoney(c.parsed)}` } } } }
  });
}

function renderCurrentCycleList() {
  const cycle = state.stats.currentCycle;
  const entries = state.entries.filter(e => e.billing_cycle_date === cycle);
  const countEl = document.getElementById('currentCycleCount');
  const listEl = document.getElementById('currentCycleList');
  countEl.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'sale' : 'sales'}` : '';
  if (!entries.length) {
    listEl.innerHTML = `<div class="text-center py-8 text-slate-500">
      <i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <p class="text-sm">No sales in this pay cycle yet</p>
      <button onclick="document.getElementById('dashNewEntryBtn').click()" class="mt-3 text-sm text-indigo-600 hover:underline font-medium">Add your first sale</button>
    </div>`;
    refreshIcons();
    return;
  }
  listEl.innerHTML = `<div class="divide-y divide-slate-100">
    ${entries.map(e => `
      <div class="flex items-center justify-between py-3 gap-3">
        <div class="flex-1 min-w-0">
          <div class="font-medium text-slate-800 truncate">${escapeHtml(e.description)}</div>
          <div class="text-xs text-slate-500 mt-0.5">${fmtDate(e.sale_date)} · Sale ${fmtMoney(e.sale_amount)} · ${e.commission_rate}%</div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-semibold text-slate-900">${fmtMoney(e.commission_amount)}</div>
          <div class="mt-0.5">${statusBadge(e.status)}</div>
        </div>
      </div>
    `).join('')}
  </div>`;
  refreshIcons();
}

function renderEntries() {
  const tbody = document.getElementById('entriesBody');
  if (!state.entries.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="px-4 py-10 text-center text-slate-500">
      <i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <div>No sales yet.</div>
      <button onclick="document.getElementById('newEntryBtn').click()" class="mt-3 text-sm text-indigo-600 hover:underline font-medium">Add your first sale</button>
    </td></tr>`;
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.entries.map(e => `
    <tr>
      <td class="px-4 py-3 whitespace-nowrap text-slate-600 align-top">${fmtDate(e.sale_date)}</td>
      <td class="px-4 py-3 align-top">
        <div class="font-medium text-slate-800">${escapeHtml(e.description)}
          ${e.drive_link ? `<a href="${escapeAttr(e.drive_link)}" target="_blank" rel="noopener" class="inline-flex items-center ml-1 text-indigo-500 hover:text-indigo-700"><i data-lucide="external-link" class="w-3 h-3"></i></a>` : ''}
          ${e.attachment_count > 0 ? `<span class="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-xs font-medium" title="${e.attachment_count} attachment${e.attachment_count === 1 ? '' : 's'}"><i data-lucide="paperclip" class="w-3 h-3"></i>${e.attachment_count}</span>` : ''}
        </div>
        ${e.customer_name ? `<div class="text-xs text-slate-500">${escapeHtml(e.customer_name)}</div>` : ''}
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
        ${e.status === 'pending' ? `
          <div class="flex items-center gap-1">
            <button onclick="editEntry(${e.id})" class="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
            <button onclick="deleteMyEntry(${e.id})" class="p-2 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
          </div>
        ` : '<span class="text-xs text-slate-400 italic">locked</span>'}
      </td>
    </tr>
  `).join('');
  refreshIcons();
}

function renderDriveLinks() {
  const container = document.getElementById('driveLinks');
  if (!state.driveLinks.length) {
    container.innerHTML = `<div class="col-span-full stat-card text-center py-12">
      <i data-lucide="folder-open" class="w-10 h-10 mx-auto mb-3 text-slate-300"></i>
      <p class="text-slate-500">No resources yet — your admin can add some.</p>
    </div>`;
    refreshIcons();
    return;
  }
  container.innerHTML = state.driveLinks.map(l => `
    <a href="${escapeAttr(l.url)}" target="_blank" rel="noopener" class="stat-card hover:border-indigo-200 transition block group">
      <div class="flex items-start gap-3">
        <div class="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><i data-lucide="folder" class="w-5 h-5"></i></div>
        <div class="flex-1 min-w-0">
          <div class="font-semibold text-slate-900 group-hover:text-indigo-600 truncate">${escapeHtml(l.title)}</div>
          ${l.description ? `<div class="text-sm text-slate-600 mt-1 line-clamp-2">${escapeHtml(l.description)}</div>` : ''}
          <div class="text-xs text-slate-400 mt-2 truncate">${escapeHtml(l.url)}</div>
        </div>
      </div>
    </a>
  `).join('');
  refreshIcons();
}

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  document.getElementById('profileName').textContent = p.full_name;
  document.getElementById('profileUsername').textContent = '@' + p.username;
  document.getElementById('profileRate').textContent = (p.default_commission_rate || 70) + '%';
}

// ========== MY PAY ==========
async function loadPaySummary() {
  try {
    state.paySummary = await API.fetch('/api/personnel/me/pay-summary');
    renderPaySummary();
    refreshIcons();
  } catch (e) { toast(e.message, 'error'); }
}

function renderPaySummary() {
  const s = state.paySummary;
  if (!s) return;
  document.getElementById('payHeroDate').textContent = fmtDate(s.currentCycle);
  document.getElementById('payHeroAmount').textContent = fmtMoney(s.upcomingPayout.total);
  document.getElementById('payHeroCount').textContent = fmtInt(s.upcomingPayout.count);
  document.getElementById('payYtd').textContent = fmtMoney(s.ytd);
  document.getElementById('payLifetimePending').textContent = fmtMoney(s.lifetimeTotals.pending + s.lifetimeTotals.unpaid);
  document.getElementById('payLifetimePaid').textContent = fmtMoney(s.lifetimeTotals.paid);
  document.getElementById('payStubCycle').textContent = fmtDate(s.currentCycle);

  const stub = document.getElementById('payStubEntries');
  if (!s.cycleEntries.length) {
    stub.innerHTML = '<div class="text-center py-6 text-slate-400 text-sm">No sales in this pay cycle yet.</div>';
  } else {
    stub.innerHTML = s.cycleEntries.map(e => `
      <div class="border border-slate-200 rounded-xl p-4 hover:border-indigo-200 transition">
        <div class="flex items-start justify-between gap-3 mb-2">
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-slate-900">${escapeHtml(e.description)}</div>
            ${e.customer_name ? `<div class="text-xs text-slate-500">${escapeHtml(e.customer_name)}</div>` : ''}
            <div class="text-xs text-slate-500 mt-0.5">${fmtDate(e.sale_date)}</div>
          </div>
          ${statusBadge(e.status)}
        </div>
        ${commissionBreakdownHTML(e)}
      </div>
    `).join('');
  }

  const histEl = document.getElementById('payHistory');
  if (!s.payHistory.length) {
    histEl.innerHTML = '<div class="text-center py-6 text-slate-400 text-sm">No past payouts yet.</div>';
  } else {
    histEl.innerHTML = `<div class="divide-y divide-slate-100">
      ${s.payHistory.map(h => `
        <div class="flex items-center justify-between py-3">
          <div>
            <div class="font-medium text-slate-800">${fmtDate(h.cycle)}</div>
            <div class="text-xs text-slate-500">${h.count} ${h.count === 1 ? 'sale' : 'sales'}</div>
          </div>
          <div class="text-lg font-bold text-emerald-600">${fmtMoney(h.total)}</div>
        </div>
      `).join('')}
    </div>`;
  }
}

function commissionBreakdownHTML(e) {
  const sale = e.sale_amount || 0;
  const ded = e.deductions || 0;
  const bon = e.bonuses || 0;
  const base = Math.max(0, sale - ded);
  const gross = (base * (e.commission_rate || 70)) / 100;
  return `
    <dl class="text-sm space-y-1 mt-3 pt-3 border-t border-slate-100">
      <div class="flex justify-between"><dt class="text-slate-500">Sale amount</dt><dd class="text-slate-900">${fmtMoney(sale)}</dd></div>
      ${ded > 0 ? `<div class="flex justify-between"><dt class="text-slate-500">Less: deductions</dt><dd class="text-slate-900">−${fmtMoney(ded)}</dd></div>` : ''}
      <div class="flex justify-between"><dt class="text-slate-500">× ${e.commission_rate}%</dt><dd class="text-slate-900">${fmtMoney(gross)}</dd></div>
      ${bon > 0 ? `<div class="flex justify-between"><dt class="text-slate-500">+ Bonus</dt><dd class="text-slate-900">+${fmtMoney(bon)}</dd></div>` : ''}
      <div class="flex justify-between border-t border-slate-100 pt-1.5 mt-1.5"><dt class="text-slate-700 font-semibold">Your payout</dt><dd class="text-base font-bold text-indigo-700">${fmtMoney(e.commission_amount)}</dd></div>
    </dl>
  `;
}

// ========== ENTRY WIZARD ==========
function setupEntryWizard() {
  const modal = document.getElementById('entryModal');
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(modal)));

  document.getElementById('saleAmountInput').addEventListener('input', updateBreakdown);
  document.querySelector('#entryForm input[name="deductions"]').addEventListener('input', updateBreakdown);
  document.querySelector('#entryForm input[name="bonuses"]').addEventListener('input', updateBreakdown);

  // Step 1: PDF
  document.getElementById('pdfInput').addEventListener('change', (e) => handlePdfFile(e.target.files[0]));
  document.getElementById('skipPdfBtn').addEventListener('click', () => goToStep(2));
  setupDropzone('pdfDropzone', (files) => {
    const pdf = files.find(f => f.type === 'application/pdf');
    if (pdf) handlePdfFile(pdf);
    else toast('Please drop a PDF file', 'warn');
  });

  // Step 3 attachments
  document.getElementById('attachInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    queueFiles(files);
  });
  setupDropzone('attachDropzone', (files) => queueFiles(files));

  // Wizard navigation
  document.getElementById('wizardBackBtn').addEventListener('click', () => goToStep(modalState.step - 1));
  document.getElementById('wizardNextBtn').addEventListener('click', () => {
    if (modalState.step === 2 && !validateStep2()) return;
    goToStep(modalState.step + 1);
  });
  document.getElementById('wizardSubmitBtn').addEventListener('click', submitEntry);
}

function setupDropzone(id, onFiles) {
  const el = document.getElementById(id);
  if (!el) return;
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

async function handlePdfFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf') { toast('Please upload a PDF', 'warn'); return; }
  if (file.size > 10 * 1024 * 1024) { toast('PDF too large (max 10MB)', 'warn'); return; }

  const status = document.getElementById('pdfStatus');
  status.classList.remove('hidden', 'text-rose-600');
  status.classList.add('text-slate-600');
  status.innerHTML = `<div class="inline-flex items-center gap-2"><div class="w-4 h-4 border-2 border-slate-300 border-t-slate-700 rounded-full animate-spin"></div>Reading "${escapeHtml(file.name)}"...</div>`;

  try {
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
    const result = await res.json();
    modalState.prefilled = result.fields;
    const found = Object.keys(result.fields).filter(k => k !== 'confidence');
    if (found.length) {
      status.classList.remove('text-slate-600');
      status.classList.add('text-emerald-600');
      status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="check-circle-2" class="w-4 h-4"></i>Found: ${found.join(', ').replace(/_/g, ' ')}. Moving to review...</div>`;
      refreshIcons();
      setTimeout(() => { applyPrefill(); goToStep(2); }, 800);
    } else {
      status.classList.add('text-amber-600');
      status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="alert-circle" class="w-4 h-4"></i>We couldn't find any details in this PDF. You can type them manually next.</div>`;
      refreshIcons();
      setTimeout(() => goToStep(2), 1500);
    }
  } catch (e) {
    status.classList.remove('text-slate-600', 'text-emerald-600');
    status.classList.add('text-rose-600');
    status.innerHTML = `<div class="inline-flex items-center gap-2"><i data-lucide="alert-circle" class="w-4 h-4"></i>${escapeHtml(e.message)}</div>`;
    refreshIcons();
  }
}

function applyPrefill() {
  if (!modalState.prefilled) return;
  const f = document.getElementById('entryForm');
  const p = modalState.prefilled;
  if (p.sale_date) f.sale_date.value = p.sale_date;
  if (p.customer_name) f.customer_name.value = p.customer_name;
  if (p.description) f.description.value = p.description;
  if (p.sale_amount) f.sale_amount.value = p.sale_amount;
  if (p.notes) f.notes.value = p.notes;
  updateBreakdown();
}

function goToStep(n) {
  if (n < 1 || n > 3) return;
  modalState.step = n;
  // Panels
  document.querySelectorAll('[data-wizard-panel]').forEach(el => {
    el.classList.toggle('hidden', parseInt(el.dataset.wizardPanel) !== n);
  });
  // Steps visual
  document.querySelectorAll('[data-wizard-step]').forEach(el => {
    const stepN = parseInt(el.dataset.wizardStep);
    const circle = el.querySelector('.step-circle');
    const label = el.querySelector('.step-label');
    if (stepN < n) {
      circle.className = 'step-circle bg-emerald-500 text-white';
      circle.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i>';
      label.classList.remove('text-slate-400');
      label.classList.add('text-emerald-600');
    } else if (stepN === n) {
      circle.className = 'step-circle bg-indigo-600 text-white';
      circle.textContent = stepN;
      label.classList.remove('text-slate-400');
      label.classList.add('text-indigo-700', 'font-semibold');
    } else {
      circle.className = 'step-circle bg-slate-200 text-slate-500';
      circle.textContent = stepN;
      label.classList.add('text-slate-400');
      label.classList.remove('text-indigo-700', 'font-semibold', 'text-emerald-600');
    }
  });
  // Buttons
  document.getElementById('wizardBackBtn').classList.toggle('hidden', n === 1);
  document.getElementById('wizardNextBtn').classList.toggle('hidden', n === 3);
  document.getElementById('wizardSubmitBtn').classList.toggle('hidden', n !== 3);
  if (n === 3) renderConfirmSummary();
  refreshIcons();
}

function validateStep2() {
  const f = document.getElementById('entryForm');
  if (!f.sale_date.value) { toast('Please pick the sale date', 'warn'); f.sale_date.focus(); return false; }
  if (!f.description.value.trim()) { toast('Tell us what you sold', 'warn'); f.description.focus(); return false; }
  if (!f.sale_amount.value || parseFloat(f.sale_amount.value) <= 0) { toast('Enter a valid sale amount', 'warn'); f.sale_amount.focus(); return false; }
  return true;
}

function updateBreakdown() {
  const f = document.getElementById('entryForm');
  const sale = parseFloat(f.sale_amount.value) || 0;
  const ded = parseFloat(f.deductions?.value) || 0;
  const bon = parseFloat(f.bonuses?.value) || 0;
  const rate = state.profile?.default_commission_rate || 70;
  const base = Math.max(0, sale - ded);
  const gross = (base * rate) / 100;
  const total = Math.max(0, gross + bon);
  document.getElementById('bdSale').textContent = fmtMoney(sale);
  document.getElementById('bdDed').textContent = '−' + fmtMoney(ded);
  document.getElementById('bdBase').textContent = fmtMoney(base);
  document.getElementById('bdRate').textContent = rate;
  document.getElementById('bdGross').textContent = fmtMoney(gross);
  document.getElementById('bdBon').textContent = '+' + fmtMoney(bon);
  document.getElementById('bdTotal').textContent = fmtMoney(total);
}

function renderConfirmSummary() {
  const f = document.getElementById('entryForm');
  const sale = parseFloat(f.sale_amount.value) || 0;
  const ded = parseFloat(f.deductions?.value) || 0;
  const bon = parseFloat(f.bonuses?.value) || 0;
  const rate = state.profile?.default_commission_rate || 70;
  const base = Math.max(0, sale - ded);
  const total = Math.max(0, (base * rate) / 100 + bon);

  document.getElementById('confirmSummary').innerHTML = `
    <div class="grid grid-cols-2 gap-x-4 gap-y-2">
      <div><span class="text-slate-500">Date:</span> <span class="font-medium">${fmtDate(f.sale_date.value)}</span></div>
      <div><span class="text-slate-500">Customer:</span> <span class="font-medium">${escapeHtml(f.customer_name.value || '—')}</span></div>
      <div class="col-span-2"><span class="text-slate-500">Sold:</span> <span class="font-medium">${escapeHtml(f.description.value || '—')}</span></div>
      <div><span class="text-slate-500">Sale amount:</span> <span class="font-semibold">${fmtMoney(sale)}</span></div>
      <div><span class="text-slate-500">Estimated payout:</span> <span class="font-bold text-indigo-700">${fmtMoney(total)}</span></div>
    </div>
  `;
}

async function submitEntry() {
  if (!validateStep2()) { goToStep(2); return; }
  const f = document.getElementById('entryForm');
  const fd = new FormData(f);
  const body = {};
  for (const [k, v] of fd.entries()) {
    if (k !== 'id' && k !== 'files') body[k] = v;
  }
  const id = fd.get('id');
  const submitBtn = document.getElementById('wizardSubmitBtn');
  submitBtn.disabled = true;
  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Saving...';

  try {
    let entryId = id ? parseInt(id) : null;
    if (entryId) {
      await API.fetch(`/api/personnel/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      const created = await API.fetch('/api/personnel/entries', { method: 'POST', body: JSON.stringify(body) });
      entryId = created.id;
    }
    if (modalState.queue.length > 0) {
      submitBtn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Uploading files...';
      for (let i = 0; i < modalState.queue.length; i += ATTACHMENT_LIMITS.maxPerUpload) {
        const chunk = modalState.queue.slice(i, i + ATTACHMENT_LIMITS.maxPerUpload);
        await uploadAttachments(entryId, chunk);
      }
    }
    toast(id ? 'Sale updated!' : "Nice — your sale is in! The admin will review it.", 'success');
    closeModal(document.getElementById('entryModal'));
    modalState = { entryId: null, existing: [], queue: [], step: 1, prefilled: null };
    await refresh();
    if (state.paySummary) loadPaySummary();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalText;
    refreshIcons();
  }
}

// ========== ATTACHMENT QUEUE (in wizard) ==========
function queueFiles(files) {
  for (const f of files) {
    if (!ATTACHMENT_LIMITS.acceptMime.includes(f.type)) { toast(`"${f.name}" — file type not allowed`, 'warn'); continue; }
    if (f.size > ATTACHMENT_LIMITS.maxFileSize) { toast(`"${f.name}" — too large (max ${ATTACHMENT_LIMITS.maxFileSize / 1024 / 1024}MB)`, 'warn'); continue; }
    const total = modalState.existing.length + modalState.queue.length;
    if (total >= ATTACHMENT_LIMITS.maxPerEntry) { toast(`Max ${ATTACHMENT_LIMITS.maxPerEntry} files per entry`, 'warn'); break; }
    modalState.queue.push(f);
  }
  renderModalAttachments();
}

function removeFromQueue(idx) { modalState.queue.splice(idx, 1); renderModalAttachments(); }

async function removeExistingAttachment(id) {
  const ok = await confirmDialog({ title: 'Remove this file?', confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await deleteAttachment(id);
    modalState.existing = modalState.existing.filter(a => a.id !== id);
    renderModalAttachments();
    toast('File removed', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

window.removeFromQueue = removeFromQueue;
window.removeExistingAttachment = removeExistingAttachment;

function renderModalAttachments() {
  const total = modalState.existing.length + modalState.queue.length;
  const countEl = document.getElementById('attachmentCount');
  if (countEl) countEl.textContent = total ? `${total} / ${ATTACHMENT_LIMITS.maxPerEntry}` : '';

  const existingEl = document.getElementById('existingAttachments');
  if (!existingEl) return;
  if (!modalState.existing.length) { existingEl.innerHTML = ''; }
  else {
    existingEl.innerHTML = modalState.existing.map(a => `
      <div class="flex items-center gap-2 p-2 border border-slate-200 rounded-lg bg-white">
        <div id="thumb-${a.id}" class="w-10 h-10 rounded skeleton flex items-center justify-center shrink-0">
          ${!isImageMime(a.mime_type) ? attachmentIconHtml(a.mime_type) : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate">${escapeHtml(a.original_name)}</div>
          <div class="text-xs text-slate-500">${fmtBytes(a.size)}</div>
        </div>
        <button type="button" onclick="openAttachmentModal(${a.id})" class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="View"><i data-lucide="eye" class="w-4 h-4"></i></button>
        <button type="button" onclick="removeExistingAttachment(${a.id})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded" title="Remove"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
      </div>
    `).join('');
    loadThumbnails(modalState.existing);
  }

  const queueEl = document.getElementById('queuedAttachments');
  if (!queueEl) return;
  if (!modalState.queue.length) { queueEl.innerHTML = ''; }
  else {
    queueEl.innerHTML = modalState.queue.map((f, i) => `
      <div class="flex items-center gap-2 p-2 border border-amber-200 bg-amber-50/50 rounded-lg">
        <div class="w-10 h-10 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
          ${attachmentIconHtml(f.type)}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium text-slate-800 truncate">${escapeHtml(f.name)}</div>
          <div class="text-xs text-amber-700">${fmtBytes(f.size)} · queued</div>
        </div>
        <button type="button" onclick="removeFromQueue(${i})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded"><i data-lucide="x" class="w-4 h-4"></i></button>
      </div>
    `).join('');
  }
  refreshIcons();
}

async function openEntryModal(entry = null) {
  const modal = document.getElementById('entryModal');
  const form = document.getElementById('entryForm');
  form.reset();
  modalState = { entryId: entry?.id || null, existing: [], queue: [], step: 1, prefilled: null };

  if (entry) {
    form.id.value = entry.id;
    form.sale_date.value = entry.sale_date;
    if (entry.customer_name) form.customer_name.value = entry.customer_name;
    form.description.value = entry.description;
    form.sale_amount.value = entry.sale_amount;
    if (entry.deductions) form.deductions.value = entry.deductions;
    if (entry.bonuses) form.bonuses.value = entry.bonuses;
    form.notes.value = entry.notes || '';
    document.getElementById('wizardTitle').textContent = 'Edit Sale';
    try { modalState.existing = await listAttachments(entry.id); } catch (_) {}
    goToStep(2); // skip PDF step when editing
  } else {
    form.id.value = '';
    form.sale_date.value = new Date().toISOString().slice(0, 10);
    document.getElementById('wizardTitle').textContent = 'Add a Sale';
    goToStep(1);
  }
  updateBreakdown();
  renderModalAttachments();
  openModal(modal);
  refreshIcons();
}

window.editEntry = function(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (e.status !== 'pending') { toast('Only pending sales can be edited', 'warn'); return; }
  openEntryModal(e);
};

window.deleteMyEntry = async function(id) {
  const ok = await confirmDialog({ title: 'Remove this sale?', message: "This can't be undone.", confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await API.fetch(`/api/personnel/entries/${id}`, { method: 'DELETE' });
    toast('Sale removed', 'success');
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
    toast("Password updated. You're set!", 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// ========== FIRST-TIME TOUR ==========
const tourSteps = [
  { selector: '[data-tab="dashboard"]', title: 'Welcome to your portal!', body: "This is your home base. You'll see your earnings, recent sales, and what's coming up." },
  { selector: '#dashNewEntryBtn', title: 'Add a sale here', body: "Click this big yellow button whenever you make a sale. We'll guide you step-by-step." },
  { selector: '[data-tab="pay"]', title: 'See your pay', body: 'My Pay shows what you\'ll be paid this Friday and your past payouts.' },
  { selector: '[data-tab="entries"]', title: 'All your sales', body: 'My Sales lists everything you\'ve submitted. You can edit pending ones here.' },
  { selector: '[data-tab="settings"]', title: 'You can re-watch this anytime', body: 'Find the tour again under Settings. Now go make a sale!' }
];
let tourIdx = 0;

function startTour(force = false) {
  if (!force && localStorage.getItem('tourSeen')) return;
  tourIdx = 0;
  document.getElementById('tourOverlay').classList.remove('hidden');
  document.getElementById('tourSkipBtn').addEventListener('click', endTour);
  document.getElementById('tourNextBtn').addEventListener('click', nextTourStep);
  showTourStep();
}

function showTourStep() {
  const step = tourSteps[tourIdx];
  if (!step) { endTour(); return; }
  const target = document.querySelector(step.selector);
  document.getElementById('tourTitle').textContent = step.title;
  document.getElementById('tourBody').textContent = step.body;
  document.getElementById('tourProgress').textContent = `Step ${tourIdx + 1} of ${tourSteps.length}`;
  document.getElementById('tourNextBtn').textContent = tourIdx === tourSteps.length - 1 ? "Got it" : 'Next';
  refreshIcons();

  // position the card near the target
  const card = document.getElementById('tourCard');
  if (target) {
    const r = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    let top = r.bottom + 12;
    let left = r.left;
    if (top + cardRect.height > window.innerHeight - 20) top = r.top - cardRect.height - 12;
    if (left + cardRect.width > window.innerWidth - 20) left = window.innerWidth - cardRect.width - 20;
    if (left < 20) left = 20;
    if (top < 20) top = 20;
    card.style.top = top + 'px';
    card.style.left = left + 'px';
    target.classList.add('ring-4', 'ring-amber-300', 'ring-offset-2', 'rounded-lg');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else {
    card.style.top = '50%';
    card.style.left = '50%';
    card.style.transform = 'translate(-50%, -50%)';
  }
}

function nextTourStep() {
  // remove ring from previous
  const prev = tourSteps[tourIdx]?.selector;
  if (prev) document.querySelectorAll(prev).forEach(el => el.classList.remove('ring-4', 'ring-amber-300', 'ring-offset-2', 'rounded-lg'));
  tourIdx++;
  if (tourIdx >= tourSteps.length) { endTour(); return; }
  showTourStep();
}

function endTour() {
  localStorage.setItem('tourSeen', '1');
  // remove all rings
  tourSteps.forEach(s => document.querySelectorAll(s.selector).forEach(el => el.classList.remove('ring-4', 'ring-amber-300', 'ring-offset-2', 'rounded-lg')));
  document.getElementById('tourOverlay').classList.add('hidden');
}
