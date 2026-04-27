const user = requireAuth('personnel');

const state = {
  entries: [],
  driveLinks: [],
  stats: null,
  profile: null
};

const charts = {};

if (user) {
  document.getElementById('userLabel').textContent = user.full_name;
  document.getElementById('userAvatar').textContent = user.full_name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.getElementById('greetingText').textContent = `Hi, ${user.full_name.split(' ')[0]}`;
  logoutSetup();
  applyChartDefaults();
  setupTabs();
  init();
}

async function init() {
  await refresh();
  setupEntryModal();
  document.getElementById('newEntryBtn').addEventListener('click', () => openEntryModal());
  document.getElementById('dashNewEntryBtn').addEventListener('click', () => openEntryModal());
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  refreshIcons();
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
  } catch (e) {
    console.error(e);
    toast(e.message, 'error');
  }
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
    data: {
      labels,
      datasets: [
        { label: 'Commission', data: commission, borderColor: '#0b2545', backgroundColor: gradient, tension: 0.4, fill: true, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#ffb703', pointBorderColor: '#0b2545', pointBorderWidth: 2, borderWidth: 2.5 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` ${fmtMoney(c.parsed.y)}` } }
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
  breakdown.forEach(b => map[b.status] = b.amount);
  const total = map.paid + map.pending + map.unpaid;
  if (charts.status) charts.status.destroy();
  if (total === 0) {
    ctx.parentElement.innerHTML = '<div class="text-center text-slate-400 text-sm py-12"><i data-lucide="pie-chart" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>No entries yet</div>';
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
        tooltip: { callbacks: { label: (c) => ` ${c.label}: ${fmtMoney(c.parsed)}` } }
      }
    }
  });
}

function renderCurrentCycleList() {
  const cycle = state.stats.currentCycle;
  const entries = state.entries.filter(e => e.billing_cycle_date === cycle);
  const countEl = document.getElementById('currentCycleCount');
  const listEl = document.getElementById('currentCycleList');
  countEl.textContent = entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : '';
  if (!entries.length) {
    listEl.innerHTML = `<div class="text-center py-8 text-slate-500">
      <i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <p class="text-sm">No entries in this cycle yet</p>
      <button onclick="document.getElementById('dashNewEntryBtn').click()" class="mt-3 text-sm text-indigo-600 hover:underline font-medium">Add your first entry</button>
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
      <div>No entries yet.</div>
      <button onclick="document.getElementById('newEntryBtn').click()" class="mt-3 text-sm text-indigo-600 hover:underline font-medium">Submit your first entry</button>
    </td></tr>`;
    refreshIcons();
    return;
  }
  tbody.innerHTML = state.entries.map(e => `
    <tr>
      <td class="px-4 py-3 whitespace-nowrap text-slate-600 align-top">${fmtDate(e.sale_date)}</td>
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
        ${e.status === 'pending' ? `
          <div class="flex items-center gap-1">
            <button onclick="editEntry(${e.id})" class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded" title="Edit"><i data-lucide="pencil" class="w-4 h-4"></i></button>
            <button onclick="deleteMyEntry(${e.id})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded" title="Delete"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
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
      <p class="text-slate-500">No drive links available yet.</p>
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

// ========== entry modal ==========
let modalState = {
  entryId: null,           // null when creating
  existing: [],            // attachments already on the entry
  queue: []                // File objects queued for upload
};

function setupEntryModal() {
  const modal = document.getElementById('entryModal');
  const form = document.getElementById('entryForm');
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(modal)));

  document.getElementById('saleAmountInput').addEventListener('input', updateCommissionPreview);

  document.getElementById('attachInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    queueFiles(files);
  });

  // Drag-and-drop on the dropzone label
  const dropzone = document.querySelector('label[for="attachInput"]');
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.add('border-indigo-500', 'bg-indigo-50');
    }));
    ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      dropzone.classList.remove('border-indigo-500', 'bg-indigo-50');
    }));
    dropzone.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) queueFiles(files);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) {
      if (k !== 'id' && k !== 'files') body[k] = v;
    }
    const id = fd.get('id');
    const submitBtn = document.getElementById('entrySubmitBtn');
    submitBtn.disabled = true;
    const originalText = submitBtn.textContent;
    submitBtn.textContent = 'Saving...';

    try {
      let entryId = id ? parseInt(id) : null;
      if (entryId) {
        await API.fetch(`/api/personnel/entries/${entryId}`, { method: 'PATCH', body: JSON.stringify(body) });
      } else {
        const created = await API.fetch('/api/personnel/entries', { method: 'POST', body: JSON.stringify(body) });
        entryId = created.id;
      }

      if (modalState.queue.length > 0) {
        submitBtn.textContent = 'Uploading...';
        // chunk by max-per-upload limit
        for (let i = 0; i < modalState.queue.length; i += ATTACHMENT_LIMITS.maxPerUpload) {
          const chunk = modalState.queue.slice(i, i + ATTACHMENT_LIMITS.maxPerUpload);
          await uploadAttachments(entryId, chunk);
        }
      }

      toast(id ? 'Entry updated' : 'Entry submitted — awaiting admin verification', 'success');
      closeModal(modal);
      modalState = { entryId: null, existing: [], queue: [] };
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });
}

function queueFiles(files) {
  for (const f of files) {
    if (!ATTACHMENT_LIMITS.acceptMime.includes(f.type)) {
      toast(`"${f.name}" — file type not allowed`, 'warn');
      continue;
    }
    if (f.size > ATTACHMENT_LIMITS.maxFileSize) {
      toast(`"${f.name}" — too large (max ${ATTACHMENT_LIMITS.maxFileSize / 1024 / 1024}MB)`, 'warn');
      continue;
    }
    const total = modalState.existing.length + modalState.queue.length;
    if (total >= ATTACHMENT_LIMITS.maxPerEntry) {
      toast(`Max ${ATTACHMENT_LIMITS.maxPerEntry} attachments per entry`, 'warn');
      break;
    }
    modalState.queue.push(f);
  }
  renderModalAttachments();
}

function removeFromQueue(idx) {
  modalState.queue.splice(idx, 1);
  renderModalAttachments();
}

async function removeExistingAttachment(id) {
  const ok = await confirmDialog({ title: 'Remove attachment?', confirmText: 'Remove', danger: true });
  if (!ok) return;
  try {
    await deleteAttachment(id);
    modalState.existing = modalState.existing.filter(a => a.id !== id);
    renderModalAttachments();
    toast('Attachment removed', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

window.removeFromQueue = removeFromQueue;
window.removeExistingAttachment = removeExistingAttachment;

function renderModalAttachments() {
  const total = modalState.existing.length + modalState.queue.length;
  document.getElementById('attachmentCount').textContent = total
    ? `${total} / ${ATTACHMENT_LIMITS.maxPerEntry}`
    : '';

  const existingEl = document.getElementById('existingAttachments');
  if (!modalState.existing.length) {
    existingEl.innerHTML = '';
  } else {
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
  if (!modalState.queue.length) {
    queueEl.innerHTML = '';
  } else {
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

function updateCommissionPreview() {
  const form = document.getElementById('entryForm');
  const sale = parseFloat(form.sale_amount.value) || 0;
  const rate = state.profile?.default_commission_rate || 70;
  const preview = (sale * rate) / 100;
  document.getElementById('commissionPreview').textContent = sale > 0
    ? `Estimated commission at your default ${rate}%: ${fmtMoney(preview)} (admin will confirm the final rate)`
    : '';
}

async function openEntryModal(entry = null) {
  const modal = document.getElementById('entryModal');
  const form = document.getElementById('entryForm');
  form.reset();
  modalState = { entryId: entry?.id || null, existing: [], queue: [] };

  if (entry) {
    form.id.value = entry.id;
    form.sale_date.value = entry.sale_date;
    form.description.value = entry.description;
    form.sale_amount.value = entry.sale_amount;
    form.drive_link.value = entry.drive_link || '';
    form.notes.value = entry.notes || '';
    document.getElementById('entryModalTitle').textContent = 'Edit Entry';
    document.getElementById('entrySubmitBtn').textContent = 'Save Changes';
    try {
      modalState.existing = await listAttachments(entry.id);
    } catch (e) { /* ignore */ }
  } else {
    form.id.value = '';
    form.sale_date.value = new Date().toISOString().slice(0, 10);
    document.getElementById('entryModalTitle').textContent = 'New Entry';
    document.getElementById('entrySubmitBtn').textContent = 'Submit';
  }
  updateCommissionPreview();
  renderModalAttachments();
  openModal(modal);
  refreshIcons();
}

window.editEntry = function(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (e.status !== 'pending') {
    toast('Only pending entries can be edited', 'warn');
    return;
  }
  openEntryModal(e);
};

window.deleteMyEntry = async function(id) {
  const ok = await confirmDialog({ title: 'Delete entry?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await API.fetch(`/api/personnel/entries/${id}`, { method: 'DELETE' });
    toast('Entry deleted', 'success');
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
