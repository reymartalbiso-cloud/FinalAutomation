const user = requireAuth('surveyor');

const state = {
  pending: [],
  completed: [],
  stats: null,
  profile: null
};

let activateTab;
let visitState = { entryId: null, queue: [], existing: [] };

if (user) {
  document.getElementById('userLabel').textContent = user.full_name;
  document.getElementById('userAvatar').textContent = user.full_name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.getElementById('greetingText').textContent = `Hi, ${user.full_name.split(' ')[0]}!`;
  logoutSetup();
  activateTab = setupTabs((tab) => {
    if (tab === 'pending') loadPending();
    if (tab === 'completed') loadCompleted();
  });
  init();
}

async function init() {
  await refresh();
  setupVisitModal();
  document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  document.getElementById('pendingSearch').addEventListener('input', debounce((e) => loadPending(e.target.value), 250));
  refreshIcons();
}

function debounce(fn, d) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), d); }; }

async function refresh() {
  try {
    const [stats, profile] = await Promise.all([
      API.fetch('/api/surveyor/me/stats'),
      API.fetch('/api/auth/me')
    ]);
    state.stats = stats;
    state.profile = profile.user;
    renderStats();
    renderProfile();
    renderRecentVisits();
    updatePendingBadge();
    refreshIcons();
  } catch (e) { console.error(e); toast(e.message, 'error'); }
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  document.getElementById('statPending').textContent = fmtInt(s.pending);
  document.getElementById('statCompleted').textContent = fmtInt(s.myCompleted);
  document.getElementById('statFlagged').textContent = fmtInt(s.flagged);
  document.getElementById('statAdjustments').textContent = fmtMoney(s.adjustmentsTotal);
}

function updatePendingBadge() {
  const badge = document.getElementById('pendingBadge');
  const count = state.stats?.pending || 0;
  if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
  else { badge.classList.add('hidden'); }
}

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  document.getElementById('profileName').textContent = p.full_name;
  document.getElementById('profileUsername').textContent = '@' + p.username;
}

function renderRecentVisits() {
  const el = document.getElementById('recentVisits');
  const list = state.stats?.recent || [];
  if (!list.length) {
    el.innerHTML = `<div class="text-center py-8 text-slate-500">
      <i data-lucide="map-pin" class="w-10 h-10 mx-auto mb-2 text-slate-300"></i>
      <p class="text-sm">No visits logged yet.</p>
    </div>`;
    refreshIcons();
    return;
  }
  el.innerHTML = `<div class="divide-y divide-slate-100">
    ${list.map(v => `
      <div class="flex items-start justify-between py-3 gap-3">
        <div class="flex-1 min-w-0">
          <div class="font-medium text-slate-800 truncate">${escapeHtml(v.description)}</div>
          <div class="text-xs text-slate-500 mt-0.5">${escapeHtml(v.customer_name || '—')} · Sale by ${escapeHtml(v.personnel_name)}</div>
          ${v.site_adjustment_reason ? `<div class="text-xs text-amber-700 mt-1">⚠ ${escapeHtml(v.site_adjustment_reason)}</div>` : ''}
        </div>
        <div class="text-right shrink-0">
          ${v.site_adjustment > 0 ? `<div class="text-sm font-semibold text-amber-600">+${fmtMoney(v.site_adjustment)}</div>` : '<div class="text-xs text-emerald-600">Cleared</div>'}
          <div class="text-xs text-slate-400 mt-0.5">${fmtRelative(v.site_visited_at)}</div>
        </div>
      </div>
    `).join('')}
  </div>`;
  refreshIcons();
}

async function loadPending(search = '') {
  try {
    const q = new URLSearchParams({ status: 'pending' });
    if (search) q.set('search', search);
    state.pending = await API.fetch('/api/surveyor/queue?' + q.toString());
    renderPendingList();
    refreshIcons();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadCompleted() {
  try {
    state.completed = await API.fetch('/api/surveyor/queue?status=completed');
    renderCompletedList();
    refreshIcons();
  } catch (e) { toast(e.message, 'error'); }
}

function renderPendingList() {
  const el = document.getElementById('pendingList');
  if (!state.pending.length) {
    el.innerHTML = `<div class="stat-card text-center py-12">
      <i data-lucide="check-circle-2" class="w-12 h-12 mx-auto mb-2 text-emerald-300"></i>
      <p class="text-base font-medium text-slate-700">All caught up!</p>
      <p class="text-sm text-slate-500 mt-1">No pending site visits.</p>
    </div>`;
    refreshIcons();
    return;
  }
  el.innerHTML = state.pending.map(e => visitCardHTML(e, true)).join('');
  refreshIcons();
}

function renderCompletedList() {
  const el = document.getElementById('completedList');
  const myVisits = state.completed.filter(e => e.site_visited_by === state.profile.id);
  if (!myVisits.length) {
    el.innerHTML = `<div class="stat-card text-center py-12">
      <i data-lucide="inbox" class="w-12 h-12 mx-auto mb-2 text-slate-300"></i>
      <p class="text-sm text-slate-500">You haven't completed any visits yet.</p>
    </div>`;
    refreshIcons();
    return;
  }
  el.innerHTML = myVisits.map(e => visitCardHTML(e, false)).join('');
  refreshIcons();
}

function visitCardHTML(e, pending) {
  return `
    <div class="stat-card cursor-pointer hover:border-indigo-300" onclick="openVisit(${e.id})">
      <div class="flex items-start justify-between gap-3">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <h3 class="font-semibold text-slate-900 truncate">${escapeHtml(e.description)}</h3>
            ${e.attachment_count > 0 ? `<span class="inline-flex items-center gap-1 text-xs text-slate-500"><i data-lucide="paperclip" class="w-3 h-3"></i>${e.attachment_count}</span>` : ''}
          </div>
          <div class="text-sm text-slate-700">${escapeHtml(e.customer_name || 'No customer name')}</div>
          <div class="text-xs text-slate-500 mt-1">
            Salesperson: <strong>${escapeHtml(e.personnel_name)}</strong> · Sold ${fmtDate(e.sale_date)} · Sale ${fmtMoney(e.sale_amount)}
          </div>
          ${!pending && e.site_visit_notes ? `<div class="text-sm text-slate-700 mt-2 bg-slate-50 rounded-lg p-2 line-clamp-2">${escapeHtml(e.site_visit_notes)}</div>` : ''}
          ${!pending && e.site_adjustment > 0 ? `<div class="mt-2 text-sm text-amber-700">⚠ Adjustment: <strong>${fmtMoney(e.site_adjustment)}</strong>${e.site_adjustment_reason ? ' — ' + escapeHtml(e.site_adjustment_reason) : ''}</div>` : ''}
        </div>
        <div class="text-right shrink-0">
          ${pending
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700"><i data-lucide="clock" class="w-3 h-3"></i>Pending</span>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700"><i data-lucide="check-circle-2" class="w-3 h-3"></i>Visited</span>`
          }
          ${!pending ? `<div class="text-xs text-slate-400 mt-1">${fmtRelative(e.site_visited_at)}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

window.openVisit = async function(id) {
  const list = state.pending.length ? state.pending : state.completed;
  const entry = list.find(x => x.id === id) || (await API.fetch(`/api/surveyor/queue?status=pending`)).find(x => x.id === id);
  if (!entry) { toast('Entry not found', 'error'); return; }
  const modal = document.getElementById('visitModal');
  const form = document.getElementById('visitForm');
  form.reset();
  form.entry_id.value = entry.id;
  document.getElementById('visitModalSubtitle').textContent = entry.customer_name || entry.description;
  document.getElementById('visitSaleInfo').innerHTML = `
    <div class="grid grid-cols-2 gap-x-4 gap-y-1">
      <div><span class="text-slate-500">Customer:</span> <span class="font-medium text-slate-800">${escapeHtml(entry.customer_name || '—')}</span></div>
      <div><span class="text-slate-500">Salesperson:</span> <span class="font-medium text-slate-800">${escapeHtml(entry.personnel_name)}</span></div>
      <div class="col-span-2"><span class="text-slate-500">Item:</span> <span class="font-medium text-slate-800">${escapeHtml(entry.description)}</span></div>
      <div><span class="text-slate-500">Sale amount:</span> <span class="font-medium text-slate-800">${fmtMoney(entry.sale_amount)}</span></div>
      <div><span class="text-slate-500">Sold:</span> <span class="font-medium text-slate-800">${fmtDate(entry.sale_date)}</span></div>
    </div>
  `;
  if (entry.site_visit_notes) form.notes.value = entry.site_visit_notes;
  if (entry.site_adjustment) form.adjustment.value = entry.site_adjustment;
  if (entry.site_adjustment_reason) form.adjustment_reason.value = entry.site_adjustment_reason;
  visitState = { entryId: entry.id, queue: [], existing: [] };
  // Load existing attachments
  document.getElementById('visitExistingAttachments').innerHTML = '<div class="text-xs text-slate-400">Loading...</div>';
  try {
    const atts = await listAttachments(entry.id);
    visitState.existing = atts;
    renderExistingForVisit(atts);
  } catch (_) {
    document.getElementById('visitExistingAttachments').innerHTML = '<div class="text-xs text-slate-400">No files yet.</div>';
  }
  renderVisitQueue();
  openModal(modal);
  refreshIcons();
};

function renderExistingForVisit(atts) {
  const el = document.getElementById('visitExistingAttachments');
  if (!atts.length) {
    el.innerHTML = '<div class="text-xs text-slate-400">No files attached by personnel.</div>';
    return;
  }
  el.innerHTML = `<div class="grid grid-cols-2 gap-2">
    ${atts.map(a => `
      <button type="button" onclick="openAttachmentModal(${a.id})" class="flex items-center gap-2 p-2 border border-slate-200 rounded-lg bg-white hover:border-indigo-300 text-left transition">
        <div id="thumb-${a.id}" class="w-9 h-9 rounded ${isImageMime(a.mime_type) ? 'skeleton' : 'bg-slate-100'} flex items-center justify-center shrink-0">
          ${!isImageMime(a.mime_type) ? attachmentIconHtml(a.mime_type) : ''}
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium text-slate-800 truncate">${escapeHtml(a.original_name)}</div>
          <div class="text-xs text-slate-500">${fmtBytes(a.size)}</div>
        </div>
      </button>
    `).join('')}
  </div>`;
  loadThumbnails(atts);
  refreshIcons();
}

function setupVisitModal() {
  const modal = document.getElementById('visitModal');
  modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(modal)));
  document.getElementById('visitSubmitBtn').addEventListener('click', submitVisit);
  document.getElementById('visitAttachInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    queueVisitFiles(files);
  });
  setupVisitDropzone();
}

function setupVisitDropzone() {
  const el = document.getElementById('visitDropzone');
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
    queueVisitFiles(Array.from(e.dataTransfer.files || []));
  });
}

function queueVisitFiles(files) {
  for (const f of files) {
    if (!ATTACHMENT_LIMITS.acceptMime.includes(f.type)) { toast(`"${f.name}" — file type not allowed`, 'warn'); continue; }
    if (f.size > ATTACHMENT_LIMITS.maxFileSize) { toast(`"${f.name}" — too large`, 'warn'); continue; }
    visitState.queue.push(f);
  }
  renderVisitQueue();
}

window.removeVisitFile = function(idx) {
  visitState.queue.splice(idx, 1);
  renderVisitQueue();
};

function renderVisitQueue() {
  const el = document.getElementById('visitQueuedAttachments');
  if (!visitState.queue.length) { el.innerHTML = ''; return; }
  el.innerHTML = visitState.queue.map((f, i) => `
    <div class="flex items-center gap-2 p-2 border border-amber-200 bg-amber-50/50 rounded-lg">
      <div class="w-9 h-9 rounded bg-white border border-slate-200 flex items-center justify-center shrink-0">
        ${attachmentIconHtml(f.type)}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-slate-800 truncate">${escapeHtml(f.name)}</div>
        <div class="text-xs text-amber-700">${fmtBytes(f.size)} · queued</div>
      </div>
      <button type="button" onclick="removeVisitFile(${i})" class="p-1.5 text-slate-500 hover:text-rose-600 hover:bg-rose-50 rounded"><i data-lucide="x" class="w-4 h-4"></i></button>
    </div>
  `).join('');
  refreshIcons();
}

async function submitVisit() {
  const form = document.getElementById('visitForm');
  const entryId = parseInt(form.entry_id.value);
  if (!entryId) return;
  const fd = new FormData(form);
  const body = {
    notes: (fd.get('notes') || '').trim(),
    adjustment: parseFloat(fd.get('adjustment') || '0') || 0,
    adjustment_reason: (fd.get('adjustment_reason') || '').trim() || null
  };
  if (!body.notes) { toast('Please write your visit notes', 'warn'); form.notes.focus(); return; }
  const btn = document.getElementById('visitSubmitBtn');
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Saving...';
  try {
    await API.fetch(`/api/surveyor/entries/${entryId}/visit`, { method: 'POST', body: JSON.stringify(body) });
    if (visitState.queue.length > 0) {
      btn.innerHTML = '<div class="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin"></div> Uploading photos...';
      for (let i = 0; i < visitState.queue.length; i += ATTACHMENT_LIMITS.maxPerUpload) {
        const chunk = visitState.queue.slice(i, i + ATTACHMENT_LIMITS.maxPerUpload);
        await uploadAttachments(entryId, chunk);
      }
    }
    toast('Visit logged. Thanks!', 'success');
    closeModal(document.getElementById('visitModal'));
    visitState = { entryId: null, queue: [], existing: [] };
    await refresh();
    if (state.pending.length) await loadPending();
  } catch (e) { toast(e.message, 'error'); }
  finally {
    btn.disabled = false;
    btn.innerHTML = original;
    refreshIcons();
  }
}

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
