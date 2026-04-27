// ========== API client ==========
const API = {
  token: () => localStorage.getItem('token'),
  user: () => JSON.parse(localStorage.getItem('user') || 'null'),
  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/';
  },
  fetch: async (url, options = {}) => {
    const token = API.token();
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });
    if (res.status === 401) { API.logout(); throw new Error('Unauthorized'); }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || `HTTP ${res.status}`);
    }
    return res.json();
  }
};

// ========== auth guard ==========
function requireAuth(role) {
  const user = API.user();
  if (!user || !API.token()) { window.location.href = '/'; return null; }
  if (role && user.role !== role) {
    window.location.href = user.role === 'admin' ? '/admin' : '/personnel';
    return null;
  }
  return user;
}

// ========== formatters ==========
const CURRENCY_SYMBOL = '$';
function fmtMoney(n, opts = {}) {
  if (n == null || isNaN(n)) return CURRENCY_SYMBOL + '0.00';
  const { compact = false } = opts;
  if (compact && Math.abs(n) >= 1000) {
    if (Math.abs(n) >= 1_000_000) return CURRENCY_SYMBOL + (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (Math.abs(n) >= 1_000) return CURRENCY_SYMBOL + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  }
  return CURRENCY_SYMBOL + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString();
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtDateShort(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function fmtRelative(s) {
  if (!s) return '';
  const d = new Date(s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return fmtDateShort(s);
}

function getCurrentCycleFriday() {
  const today = new Date();
  const day = today.getDay();
  const diff = (5 - day + 7) % 7;
  today.setDate(today.getDate() + diff);
  return today.toISOString().slice(0, 10);
}

function nextFridayAfter(fridayDateStr) {
  const d = new Date(fridayDateStr + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  return d.toISOString().slice(0, 10);
}

function trendPercent(current, previous) {
  if (!previous || previous === 0) {
    if (current > 0) return { pct: 100, dir: 'up' };
    return { pct: 0, dir: 'flat' };
  }
  const pct = ((current - previous) / previous) * 100;
  return { pct: Math.abs(pct), dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' };
}

// ========== UI primitives ==========
function statusBadge(status) {
  const map = {
    paid: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-600/20',
    unpaid: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-600/20',
    pending: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-600/20'
  };
  const icons = { paid: 'check-circle-2', unpaid: 'x-circle', pending: 'clock' };
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${map[status] || 'bg-slate-100 text-slate-700'}">
    <i data-lucide="${icons[status] || 'circle'}" class="w-3 h-3"></i>${status}
  </span>`;
}

function trendChip(current, previous, opts = {}) {
  const { invertColor = false } = opts;
  const { pct, dir } = trendPercent(current, previous);
  if (dir === 'flat') return `<span class="inline-flex items-center gap-1 text-xs text-slate-500"><i data-lucide="minus" class="w-3 h-3"></i>No change</span>`;
  const goodUp = !invertColor;
  const color = (dir === 'up' && goodUp) || (dir === 'down' && !goodUp)
    ? 'text-emerald-600' : 'text-rose-600';
  const icon = dir === 'up' ? 'trending-up' : 'trending-down';
  return `<span class="inline-flex items-center gap-1 text-xs font-medium ${color}">
    <i data-lucide="${icon}" class="w-3 h-3"></i>${pct.toFixed(1)}%
  </span>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ========== toast notifications ==========
function ensureToastRoot() {
  let root = document.getElementById('toastRoot');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toastRoot';
    root.className = 'fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none';
    document.body.appendChild(root);
  }
  return root;
}

function toast(message, type = 'info', duration = 3500) {
  const root = ensureToastRoot();
  const colors = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-rose-600 text-white',
    info: 'bg-slate-800 text-white',
    warn: 'bg-amber-600 text-white'
  };
  const icons = { success: 'check-circle-2', error: 'x-circle', info: 'info', warn: 'alert-triangle' };
  const el = document.createElement('div');
  el.className = `pointer-events-auto px-4 py-3 rounded-xl shadow-lg ${colors[type]} flex items-center gap-2 text-sm font-medium min-w-[240px] max-w-sm opacity-0 translate-y-[-8px] transition-all duration-200`;
  el.innerHTML = `<i data-lucide="${icons[type]}" class="w-4 h-4 shrink-0"></i><span class="flex-1">${escapeHtml(message)}</span>`;
  root.appendChild(el);
  if (window.lucide) lucide.createIcons();
  requestAnimationFrame(() => {
    el.classList.remove('opacity-0', 'translate-y-[-8px]');
  });
  setTimeout(() => {
    el.classList.add('opacity-0', 'translate-y-[-8px]');
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ========== confirm modal ==========
function confirmDialog({ title = 'Confirm', message = 'Are you sure?', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[90]';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <div class="flex items-start gap-3 mb-4">
          <div class="w-10 h-10 rounded-full ${danger ? 'bg-rose-100 text-rose-600' : 'bg-indigo-100 text-indigo-600'} flex items-center justify-center shrink-0">
            <i data-lucide="${danger ? 'alert-triangle' : 'help-circle'}" class="w-5 h-5"></i>
          </div>
          <div class="flex-1">
            <h3 class="text-lg font-semibold text-slate-900">${escapeHtml(title)}</h3>
            <p class="text-sm text-slate-600 mt-1">${escapeHtml(message)}</p>
          </div>
        </div>
        <div class="flex gap-2 justify-end">
          <button data-action="cancel" class="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">${escapeHtml(cancelText)}</button>
          <button data-action="confirm" class="px-4 py-2 text-sm font-medium text-white ${danger ? 'bg-rose-600 hover:bg-rose-700' : 'bg-indigo-600 hover:bg-indigo-700'} rounded-lg">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons();
    const cleanup = (result) => { overlay.remove(); document.removeEventListener('keydown', onEsc); resolve(result); };
    const onEsc = (e) => { if (e.key === 'Escape') cleanup(false); };
    document.addEventListener('keydown', onEsc);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') cleanup(false);
      if (action === 'confirm') cleanup(true);
    });
  });
}

// ========== prompt modal ==========
function promptDialog({ title = 'Input', message = '', placeholder = '', initialValue = '', confirmText = 'Save', type = 'text' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4 z-[90]';
    overlay.innerHTML = `
      <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl">
        <h3 class="text-lg font-semibold text-slate-900 mb-2">${escapeHtml(title)}</h3>
        ${message ? `<p class="text-sm text-slate-600 mb-3">${escapeHtml(message)}</p>` : ''}
        <input type="${type}" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(initialValue)}" class="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none" />
        <div class="flex gap-2 justify-end mt-4">
          <button data-action="cancel" class="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">Cancel</button>
          <button data-action="confirm" class="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg">${escapeHtml(confirmText)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    setTimeout(() => input.focus(), 10);
    const cleanup = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(null);
      if (e.key === 'Enter') cleanup(input.value);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(null);
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') cleanup(null);
      if (action === 'confirm') cleanup(input.value);
    });
  });
}

// ========== modal helpers ==========
function openModal(m) {
  m.classList.remove('hidden');
  m.classList.add('flex');
  const onEsc = (e) => { if (e.key === 'Escape') { closeModal(m); document.removeEventListener('keydown', onEsc); } };
  document.addEventListener('keydown', onEsc);
  m._escHandler = onEsc;
  m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); }, { once: true });
}
function closeModal(m) {
  m.classList.add('hidden');
  m.classList.remove('flex');
  if (m._escHandler) { document.removeEventListener('keydown', m._escHandler); m._escHandler = null; }
}

// ========== tabs (with ?tab= support) ==========
function setupTabs(onChange) {
  const buttons = document.querySelectorAll('[data-tab]');
  const panels = document.querySelectorAll('[data-panel]');
  function activate(tab) {
    buttons.forEach(b => {
      const isActive = b.dataset.tab === tab;
      b.classList.toggle('tab-active', isActive);
      b.classList.toggle('active', isActive);
    });
    panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
    if (onChange) onChange(tab);
  }
  buttons.forEach(b => b.addEventListener('click', () => {
    activate(b.dataset.tab);
    history.replaceState(null, '', '?tab=' + b.dataset.tab);
  }));
  const initial = new URLSearchParams(location.search).get('tab') || buttons[0]?.dataset.tab;
  if (initial) activate(initial);
  return activate;
}

function logoutSetup() {
  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Sign out?', message: 'You will need to sign in again.', confirmText: 'Sign out' });
    if (ok) API.logout();
  });
}

// ========== chart defaults ==========
function applyChartDefaults() {
  if (!window.Chart) return;
  Chart.defaults.font.family = "'Inter', ui-sans-serif, system-ui, sans-serif";
  Chart.defaults.color = '#64748b';
  Chart.defaults.borderColor = '#e2e8f0';
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(15, 23, 42, 0.95)';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
}

// ========== icon refresh ==========
function refreshIcons() { if (window.lucide) lucide.createIcons(); }

// ========== attachments helper ==========
const ATTACHMENT_LIMITS = {
  maxFileSize: 10 * 1024 * 1024,
  maxPerEntry: 10,
  maxPerUpload: 5,
  acceptMime: ['image/jpeg','image/png','image/webp','image/heic','image/heif','image/gif','application/pdf'],
  acceptHtml: 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,application/pdf'
};

function fmtBytes(b) {
  if (b == null) return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function isImageMime(m) { return /^image\//.test(m || ''); }
function isPdfMime(m) { return m === 'application/pdf'; }

async function fetchAttachmentBlob(id) {
  const token = API.token();
  const res = await fetch('/api/attachments/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Failed to load attachment');
  return res.blob();
}

async function uploadAttachments(entryId, files) {
  const token = API.token();
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const res = await fetch('/api/entries/' + entryId + '/attachments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: fd
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || 'Upload failed');
  }
  return res.json();
}

async function deleteAttachment(id) {
  return API.fetch('/api/attachments/' + id, { method: 'DELETE' });
}

window._attCache = window._attCache || new Map();

async function listAttachments(entryId) {
  const list = await API.fetch('/api/entries/' + entryId + '/attachments');
  for (const a of list) window._attCache.set(a.id, a);
  return list;
}

async function openAttachmentModal(id) {
  const meta = window._attCache.get(id);
  if (!meta) { toast('Attachment info not available', 'error'); return; }

  // Loading shell
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4 z-[95] animate-fade-in';
  const isImage = isImageMime(meta.mime_type);
  const isPdf = isPdfMime(meta.mime_type);
  const iconColor = isImage ? 'bg-indigo-50 text-indigo-600' : isPdf ? 'bg-rose-50 text-rose-600' : 'bg-slate-100 text-slate-600';
  const iconName = isImage ? 'image' : isPdf ? 'file-text' : 'file';

  overlay.innerHTML = `
    <div class="bg-white rounded-2xl shadow-2xl flex flex-col w-full max-w-5xl ${isPdf ? 'h-[90vh]' : 'max-h-[90vh]'}">
      <div class="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-lg ${iconColor} flex items-center justify-center shrink-0">
            <i data-lucide="${iconName}" class="w-5 h-5"></i>
          </div>
          <div class="min-w-0">
            <div class="font-medium text-slate-900 truncate">${escapeHtml(meta.original_name)}</div>
            <div class="text-xs text-slate-500">${escapeHtml(meta.mime_type)} &middot; ${fmtBytes(meta.size)}</div>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <a id="attDownload" href="#" download="${escapeAttr(meta.original_name)}" class="hidden inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg hover:bg-slate-100">
            <i data-lucide="download" class="w-4 h-4"></i> Download
          </a>
          <button data-close class="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-lg" title="Close (Esc)">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
      <div id="attViewer" class="flex-1 overflow-auto bg-slate-50 flex items-center justify-center p-4 min-h-[200px]">
        <div class="text-slate-500 text-sm flex items-center gap-2">
          <div class="w-5 h-5 border-2 border-slate-300 border-t-slate-600 rounded-full animate-spin"></div>
          Loading...
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  refreshIcons();

  let blobUrl = null;
  const cleanup = () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
    if (e.target.closest('[data-close]')) cleanup();
  });

  try {
    const blob = await fetchAttachmentBlob(id);
    blobUrl = URL.createObjectURL(blob);
    const dl = overlay.querySelector('#attDownload');
    dl.href = blobUrl;
    dl.classList.remove('hidden');
    dl.classList.add('inline-flex');

    const viewer = overlay.querySelector('#attViewer');
    if (isImage) {
      viewer.innerHTML = `<img src="${blobUrl}" alt="${escapeAttr(meta.original_name)}" class="max-w-full max-h-full object-contain rounded-lg shadow" />`;
    } else if (isPdf) {
      viewer.classList.remove('p-4');
      viewer.innerHTML = `<iframe src="${blobUrl}#toolbar=1" class="w-full h-full bg-white" title="${escapeAttr(meta.original_name)}"></iframe>`;
    } else {
      viewer.innerHTML = `<div class="text-center text-slate-500">
        <i data-lucide="file" class="w-12 h-12 mx-auto mb-2 text-slate-300"></i>
        <div class="text-sm">Preview not supported for this file type.</div>
        <div class="text-xs mt-1">Click <strong>Download</strong> above to save it.</div>
      </div>`;
      refreshIcons();
    }
  } catch (e) {
    overlay.querySelector('#attViewer').innerHTML = `<div class="text-rose-600 text-sm">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

function attachmentIconHtml(mime) {
  if (isImageMime(mime)) return `<i data-lucide="image" class="w-4 h-4 text-indigo-600"></i>`;
  if (isPdfMime(mime)) return `<i data-lucide="file-text" class="w-4 h-4 text-rose-600"></i>`;
  return `<i data-lucide="file" class="w-4 h-4 text-slate-500"></i>`;
}

// Loads thumbnails for image attachments (replaces placeholders by id="thumb-<id>")
async function loadThumbnails(attachments) {
  for (const a of attachments) {
    if (!isImageMime(a.mime_type)) continue;
    const el = document.getElementById('thumb-' + a.id);
    if (!el) continue;
    try {
      const blob = await fetchAttachmentBlob(a.id);
      const url = URL.createObjectURL(blob);
      el.style.backgroundImage = `url(${url})`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.classList.remove('skeleton');
    } catch (e) { /* ignore individual failures */ }
  }
}
