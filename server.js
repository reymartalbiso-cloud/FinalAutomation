const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Enforce strong JWT secret in production
if (NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Upload directory
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============ MIDDLEWARE ============
// Trust the first hop when behind a reverse proxy (nginx/Caddy); needed for accurate IPs in audit + rate limiter
app.set('trust proxy', 1);

app.use(helmet({
  // Allow CDN scripts/styles for Tailwind/Lucide/Chart.js. For tighter prod-grade CSP,
  // self-host these assets and re-enable CSP with explicit allowlist.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: NODE_ENV === 'production' ? '1d' : 0 }));

// Light request logger
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.url.startsWith('/api/') && (res.statusCode >= 400 || NODE_ENV !== 'production')) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - t}ms)`);
    }
  });
  next();
});

// ============ HELPERS ============
function toYMD(d) { return d.toISOString().slice(0, 10); }
function getCycleFridayInclusive(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + ((5 - day + 7) % 7));
  return toYMD(d);
}
function nextCycleAfter(s) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + 7); return toYMD(d); }
function prevCycleBefore(s) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() - 7); return toYMD(d); }
function lastNCycles(n) {
  const out = [];
  let cur = getCycleFridayInclusive();
  for (let i = 0; i < n; i++) { out.unshift(cur); cur = prevCycleBefore(cur); }
  return out;
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || '';
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ============ FILE UPLOAD CONFIG ============
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif',
  'application/pdf'
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES_PER_REQUEST = 5;
const MAX_FILES_PER_ENTRY = 10;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 8);
    cb(null, crypto.randomUUID() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES_PER_REQUEST },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Unsupported file type: ' + file.mimetype));
  }
});

function safeUnlink(p) { fs.unlink(p, () => {}); }
function deleteAttachmentFiles(entryId) {
  const atts = db.prepare('SELECT filename FROM attachments WHERE entry_id = ?').all(entryId);
  atts.forEach(a => safeUnlink(path.join(UPLOAD_DIR, a.filename)));
}

// ============ AUDIT LOG ============
const insertAudit = db.prepare(`
  INSERT INTO audit_logs (actor_id, actor_username, actor_role, action, target_type, target_id, metadata, ip_address)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
function audit(req, action, targetType = null, targetId = null, metadata = null) {
  try {
    const u = req.user || {};
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    insertAudit.run(
      u.id || null, u.username || null, u.role || null,
      action, targetType, targetId,
      metadata ? JSON.stringify(metadata).slice(0, 4000) : null,
      ip || null
    );
  } catch (e) {
    console.error('[audit] failed:', e.message);
  }
}

// ============ STATS CACHE (60s TTL) ============
const statsCache = { value: null, expiresAt: 0 };
function invalidateStats() { statsCache.expiresAt = 0; }

// ============ NOTIFICATION QUEUE ============
// Notifications are written to DB. A real SMTP/SMS sender would dequeue and send.
// For now they're "queued" and visible in the admin notification log.
const insertNotification = db.prepare(`
  INSERT INTO notification_log (user_id, type, subject, body, target_type, target_id, status)
  VALUES (?, ?, ?, ?, ?, ?, 'queued')
`);
function queueNotification(userId, type, subject, body, targetType = null, targetId = null) {
  try {
    insertNotification.run(userId, type, subject, body, targetType, targetId);
  } catch (e) {
    console.error('[notify] failed:', e.message);
  }
}

// ============ PDF EXTRACTION ============
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted for extraction'));
  }
});

// Helper: scan multiple patterns and return first hit
function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m;
  }
  return null;
}

// Helper: clean up a captured "name" string
function cleanName(s) {
  if (!s) return null;
  return s
    .split(/\n|\r/)[0]                    // first line only
    .replace(/[\s,]+$/, '')               // trailing whitespace/commas
    .replace(/\s+/g, ' ')                 // collapse spaces
    .replace(/^[:#\s-]+/, '')             // leading punctuation
    .trim()
    .slice(0, 80);                        // max 80 chars
}

function extractFieldsFromText(text) {
  if (!text) return { confidence: {} };
  const t = text.replace(/\r/g, '');
  const out = { confidence: {} };

  // ============ 1. SALE AMOUNT ============
  // Try labelled totals first (high confidence), fall back to last $X.XX (medium), then any $X.XX (low)
  const labeledAmount = firstMatch(t, [
    /(?:Grand\s*Total|Total\s*Due|Total\s*Amount(?:\s*Due)?|Final\s*Total|Final\s*Amount|Contract\s*Amount|Contract\s*Total|Sale\s*Price|Sale\s*Total|System\s*(?:Total|Cost|Price)|Project\s*Total|Net\s*Total|Amount\s*Due)\s*[:$]?\s*\$?\s*([\d,]+\.\d{2})/i,
    /(?:Total|Subtotal|Amount)\s*[:$]?\s*\$?\s*([\d,]+\.\d{2})/i
  ]);
  if (labeledAmount) {
    out.sale_amount = parseFloat(labeledAmount[1].replace(/,/g, ''));
    out.confidence.sale_amount = /(grand|final|contract|total\s*due|total\s*amount|sale\s*price|sale\s*total|system|project|amount\s*due)/i.test(labeledAmount[0])
      ? 'high' : 'medium';
  } else {
    // last dollar amount on its own line, often the "total" footer
    const lastMatch = t.match(/\$\s*([\d,]+\.\d{2})\s*$/m) || t.match(/\$\s*([\d,]+\.\d{2})/);
    if (lastMatch) {
      out.sale_amount = parseFloat(lastMatch[1].replace(/,/g, ''));
      out.confidence.sale_amount = 'low';
    }
  }

  // ============ 2. SALE DATE ============
  const dateMatch = firstMatch(t, [
    /(?:Contract\s*Date|Sale\s*Date|Invoice\s*Date|Issue\s*Date|Issued|Date\s*of\s*Sale)\s*[:#]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /(?:^|\n)\s*Date\s*[:#]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2}|[A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i
  ]);
  if (dateMatch) {
    const d = new Date(dateMatch[1]);
    if (!isNaN(d.getTime())) {
      out.sale_date = d.toISOString().slice(0, 10);
      out.confidence.sale_date = 'high';
    }
  }

  // ============ 3. CUSTOMER NAME ============
  const custMatch = firstMatch(t, [
    /(?:Customer\s*Name|Bill\s*To|Sold\s*To|Buyer|Property\s*Owner|Homeowner|Client)\s*[:#]?\s*\n?\s*([A-Z][A-Za-z'.\s,&-]{2,60})/,
    /(?:^|\n)\s*Customer\s*[:#]?\s*([A-Z][A-Za-z'.\s,&-]{2,60})/
  ]);
  if (custMatch) {
    out.customer_name = cleanName(custMatch[1]);
    out.confidence.customer_name = 'medium';
  }

  // ============ 4. SALESPERSON / COMMISSIONER NAME ============
  // Look for many label variants used on solar + sales paperwork
  const salesMatch = firstMatch(t, [
    /(?:Salesperson|Sales\s*Person|Sales\s*Rep(?:resentative)?|Sales\s*Consultant|Sales\s*Agent|Sold\s*By|Closed\s*By|Closer|Set\s*By|Setter|Energy\s*Consultant|Commissioner|Commission\s*(?:Paid\s*)?To|Commission\s*Recipient|Account\s*Executive|Account\s*Manager|Agent\s*Name|Agent|Rep)\s*[:#]?\s*\n?\s*([A-Z][A-Za-z'.\s,-]{2,60})/i
  ]);
  if (salesMatch) {
    out.salesperson_name = cleanName(salesMatch[1]);
    // High confidence if label was specific (Salesperson, Sold By, etc.); medium if just "Agent"/"Rep"
    out.confidence.salesperson_name = /(salesperson|sales\s*rep|sales\s*consultant|sales\s*agent|sold\s*by|closed\s*by|closer|setter|set\s*by|energy\s*consultant|commission|account\s*executive)/i.test(salesMatch[0])
      ? 'high' : 'medium';
  }

  // ============ 5. DESCRIPTION (system size + battery) ============
  const sizeMatch = t.match(/(\d+\.?\d*)\s*kW(?:\s*(?:DC|AC))?\s*(?:solar|system|PV)?/i);
  const batteryMatch = t.match(/(Tesla\s+Powerwall(?:\s*\d)?|Powerwall|Enphase|battery\s+backup|EV\s+charger)/i);
  const descParts = [];
  if (sizeMatch) descParts.push(`${parseFloat(sizeMatch[1])}kW solar system`);
  if (batteryMatch) descParts.push(batteryMatch[1]);
  if (!descParts.length) {
    const headline = t.match(/(Residential|Commercial)\s+Solar/i);
    if (headline) descParts.push(`${headline[1]} solar installation`);
  }
  if (descParts.length) {
    out.description = descParts.join(' + ');
    out.confidence.description = 'medium';
  }

  // ============ 6. NOTES (rebate / credit) ============
  const rebateMatch = t.match(/(?:rebate|federal\s*tax\s*credit|ITC)\s*[:$]?\s*\$?\s*([\d,]+\.\d{2})/i);
  if (rebateMatch) {
    out.notes = `Rebate/credit identified: $${rebateMatch[1]}`;
  }

  return out;
}

app.post('/api/personnel/extract-pdf',
  authRequired,
  (req, res, next) => {
    pdfUpload.single('pdf')(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'PDF too large (max 10MB)' });
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
    let parser;
    try {
      const { PDFParse } = require('pdf-parse');
      parser = new PDFParse({ data: req.file.buffer });
      const textResult = await parser.getText();
      const text = textResult?.text || '';
      const pages = textResult?.pages?.length ?? textResult?.numpages ?? 0;
      const fields = extractFieldsFromText(text);
      audit(req, 'pdf.extracted', 'entry', null, { pages, fields_found: Object.keys(fields).filter(k => k !== 'confidence') });
      res.json({ fields, meta: { pages, text_length: text.length } });
    } catch (e) {
      console.error('[pdf-extract]', e.message);
      const msg = /password|encrypt/i.test(e.message)
        ? 'This PDF is password-protected. Please remove the password or type details manually.'
        : 'Could not read this PDF. It may be a scanned image. Please type details manually.';
      res.status(500).json({ error: msg });
    } finally {
      try { await parser?.destroy?.(); } catch (_) {}
    }
  }
);

function prependTransferNote(existing, from, to, reason) {
  const stamp = `[Moved ${from} → ${to}] ${reason}`;
  return existing && existing.trim() ? `${stamp}\n\n${existing}` : stamp;
}

// ============ AUTH ============
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Please try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    audit({ user: { username: String(username).slice(0, 50) }, headers: req.headers, socket: req.socket }, 'login.failed', 'user', null, { username: String(username).slice(0, 50) });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    JWT_SECRET, { expiresIn: '7d' }
  );
  audit({ user: { id: user.id, username: user.username, role: user.role }, headers: req.headers, socket: req.socket }, 'login.success', 'user', user.id);
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const row = db.prepare('SELECT id, username, role, full_name, default_commission_rate FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'User not found' });
  res.json({ user: row });
});

app.post('/api/auth/change-password', authRequired, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Missing fields' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  audit(req, 'password.changed', 'user', req.user.id);
  res.json({ ok: true });
});

// ============ PERSONNEL ============
app.get('/api/personnel/me/entries', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT *, (SELECT COUNT(*) FROM attachments WHERE entry_id = entries.id) as attachment_count
    FROM entries WHERE personnel_id = ?
    ORDER BY sale_date DESC, id DESC
  `).all(req.user.id);
  res.json(rows);
});

app.get('/api/personnel/me/stats', authRequired, (req, res) => {
  const uid = req.user.id;
  const currentCycle = getCycleFridayInclusive();

  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(sale_amount), 0) as totalSales,
      COALESCE(SUM(commission_amount), 0) as totalCommission,
      COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END), 0) as totalPaid,
      COALESCE(SUM(CASE WHEN status!='paid' THEN commission_amount ELSE 0 END), 0) as totalPending,
      COUNT(*) as totalEntries
    FROM entries WHERE personnel_id = ?
  `).get(uid);

  const currentCycleStats = db.prepare(`
    SELECT
      COALESCE(SUM(sale_amount), 0) as sales,
      COALESCE(SUM(commission_amount), 0) as commission,
      COUNT(*) as entryCount
    FROM entries WHERE personnel_id = ? AND billing_cycle_date = ?
  `).get(uid, currentCycle);

  const cycles = lastNCycles(8);
  const ph = cycles.map(() => '?').join(',');
  const trendRows = db.prepare(`
    SELECT billing_cycle_date as cycle,
      COALESCE(SUM(commission_amount), 0) as commission,
      COALESCE(SUM(sale_amount), 0) as sales,
      COUNT(*) as entry_count
    FROM entries WHERE personnel_id = ? AND billing_cycle_date IN (${ph})
    GROUP BY billing_cycle_date
  `).all(uid, ...cycles);
  const map = Object.fromEntries(trendRows.map(r => [r.cycle, r]));
  const weeklyTrend = cycles.map(c => ({
    cycle: c, commission: map[c]?.commission || 0, sales: map[c]?.sales || 0, entry_count: map[c]?.entry_count || 0
  }));

  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(commission_amount),0) as amount
    FROM entries WHERE personnel_id = ? GROUP BY status
  `).all(uid);

  res.json({ currentCycle, totals, currentCycleStats, weeklyTrend, statusBreakdown });
});

function computeCommission(sale, rate, deductions = 0, bonuses = 0) {
  const base = Math.max(0, (sale || 0) - (deductions || 0));
  const gross = (base * rate) / 100;
  return Math.max(0, gross + (bonuses || 0));
}

function safeNumber(v, fallback = 0) {
  const n = parseFloat(v);
  if (isNaN(n) || n < 0 || n > 1e9) return fallback;
  return n;
}

app.post('/api/personnel/entries', authRequired, (req, res) => {
  if (req.user.role !== 'personnel') return res.status(403).json({ error: 'Personnel only' });
  const { sale_date, description, sale_amount, notes, drive_link, customer_name, deductions, bonuses } = req.body || {};
  if (!sale_date || !description || sale_amount == null) return res.status(400).json({ error: 'Missing required fields' });
  const sale = parseFloat(sale_amount);
  if (isNaN(sale) || sale < 0 || sale > 1e9) return res.status(400).json({ error: 'Invalid sale amount' });
  if (String(description).length > 500) return res.status(400).json({ error: 'Description too long (max 500 chars)' });
  const ded = safeNumber(deductions, 0);
  const bon = safeNumber(bonuses, 0);
  const u = db.prepare('SELECT default_commission_rate FROM users WHERE id = ?').get(req.user.id);
  const rate = u?.default_commission_rate || 70;
  const commission = computeCommission(sale, rate, ded, bon);
  const cycle = getCycleFridayInclusive();
  const result = db.prepare(`
    INSERT INTO entries (personnel_id, sale_date, description, sale_amount, commission_rate, commission_amount, billing_cycle_date, notes, drive_link, customer_name, deductions, bonuses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, sale_date, description.trim(), sale, rate, commission, cycle, notes?.trim() || null, drive_link?.trim() || null, customer_name?.trim() || null, ded, bon);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid);
  audit(req, 'entry.created', 'entry', entry.id, { sale_amount: sale, commission_amount: commission, cycle });
  invalidateStats();
  res.json(entry);
});

app.patch('/api/personnel/entries/:id', authRequired, (req, res) => {
  if (req.user.role !== 'personnel') return res.status(403).json({ error: 'Personnel only' });
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND personnel_id = ?').get(id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (entry.status !== 'pending') return res.status(400).json({ error: 'Only pending entries can be edited' });
  const { sale_date, description, sale_amount, notes, drive_link, customer_name, deductions, bonuses } = req.body || {};
  const newSale = sale_amount != null ? parseFloat(sale_amount) : entry.sale_amount;
  if (isNaN(newSale) || newSale < 0 || newSale > 1e9) return res.status(400).json({ error: 'Invalid sale amount' });
  const ded = deductions != null ? safeNumber(deductions, 0) : entry.deductions || 0;
  const bon = bonuses != null ? safeNumber(bonuses, 0) : entry.bonuses || 0;
  const newCommission = computeCommission(newSale, entry.commission_rate, ded, bon);
  db.prepare(`
    UPDATE entries SET sale_date = COALESCE(?, sale_date), description = COALESCE(?, description),
      sale_amount = ?, commission_amount = ?, notes = ?, drive_link = ?, customer_name = ?,
      deductions = ?, bonuses = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(sale_date || null, description?.trim() || null, newSale, newCommission,
         notes?.trim() || null, drive_link?.trim() || null, customer_name?.trim() || null,
         ded, bon, id);
  audit(req, 'entry.edited', 'entry', id, { sale_amount: newSale, commission_amount: newCommission });
  invalidateStats();
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
});

app.delete('/api/personnel/entries/:id', authRequired, (req, res) => {
  if (req.user.role !== 'personnel') return res.status(403).json({ error: 'Personnel only' });
  const id = parseInt(req.params.id);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ? AND personnel_id = ?').get(id, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  if (entry.status !== 'pending') return res.status(400).json({ error: 'Only pending entries can be deleted' });
  deleteAttachmentFiles(id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  audit(req, 'entry.deleted', 'entry', id, { description: entry.description, commission_amount: entry.commission_amount });
  invalidateStats();
  res.json({ ok: true });
});

// ============ ATTACHMENTS ============
app.get('/api/entries/:id/attachments', authRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const entry = db.prepare('SELECT personnel_id FROM entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (req.user.role !== 'admin' && req.user.id !== entry.personnel_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const rows = db.prepare(`
    SELECT id, original_name, mime_type, size, created_at
    FROM attachments WHERE entry_id = ? ORDER BY created_at ASC, id ASC
  `).all(id);
  res.json(rows);
});

app.post('/api/entries/:id/attachments',
  authRequired,
  (req, res, next) => {
    upload.array('files', MAX_FILES_PER_REQUEST)(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
        if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: `Too many files (max ${MAX_FILES_PER_REQUEST} per upload)` });
        return res.status(400).json({ error: err.message });
      }
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  (req, res) => {
    const id = parseInt(req.params.id);
    const entry = db.prepare('SELECT personnel_id, status FROM entries WHERE id = ?').get(id);
    const cleanup = () => req.files?.forEach(f => safeUnlink(f.path));
    if (!entry) { cleanup(); return res.status(404).json({ error: 'Entry not found' }); }
    if (req.user.role !== 'admin' && req.user.id !== entry.personnel_id) {
      cleanup(); return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.user.role === 'personnel' && entry.status !== 'pending') {
      cleanup(); return res.status(400).json({ error: 'Cannot attach to verified entries' });
    }
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

    const existing = db.prepare('SELECT COUNT(*) as c FROM attachments WHERE entry_id = ?').get(id).c;
    if (existing + req.files.length > MAX_FILES_PER_ENTRY) {
      cleanup();
      return res.status(400).json({ error: `Max ${MAX_FILES_PER_ENTRY} attachments per entry (currently ${existing})` });
    }

    const ins = db.prepare(`
      INSERT INTO attachments (entry_id, filename, original_name, mime_type, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction((files) => {
      const out = [];
      for (const f of files) {
        const r = ins.run(id, f.filename, f.originalname.slice(0, 255), f.mimetype, f.size, req.user.id);
        out.push({ id: r.lastInsertRowid, original_name: f.originalname, mime_type: f.mimetype, size: f.size });
      }
      return out;
    });
    const uploaded = tx(req.files);
    audit(req, 'attachment.uploaded', 'entry', id, { count: uploaded.length, names: uploaded.map(u => u.original_name) });
    res.json({ uploaded });
  }
);

app.get('/api/attachments/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const att = db.prepare(`
    SELECT a.*, e.personnel_id FROM attachments a
    JOIN entries e ON e.id = a.entry_id
    WHERE a.id = ?
  `).get(id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && req.user.id !== att.personnel_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const filePath = path.join(UPLOAD_DIR, att.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
  res.setHeader('Content-Type', att.mime_type);
  res.setHeader('Content-Disposition', `inline; filename="${att.original_name.replace(/[^\w.\- ]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/attachments/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const att = db.prepare(`
    SELECT a.*, e.personnel_id, e.status FROM attachments a
    JOIN entries e ON e.id = a.entry_id WHERE a.id = ?
  `).get(id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  if (req.user.role !== 'admin' && req.user.id !== att.personnel_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (req.user.role === 'personnel' && att.status !== 'pending') {
    return res.status(400).json({ error: 'Cannot remove attachments from verified entries' });
  }
  safeUnlink(path.join(UPLOAD_DIR, att.filename));
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  audit(req, 'attachment.deleted', 'attachment', id, { name: att.original_name });
  res.json({ ok: true });
});

// ============ ADMIN: ENTRIES (paginated) ============
app.get('/api/admin/entries', authRequired, adminRequired, (req, res) => {
  const { search, cycle, status, personnel_id, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  let where = ' WHERE 1=1';
  const params = [];
  if (search) { where += ' AND (e.description LIKE ? OR u.full_name LIKE ? OR e.notes LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  if (cycle) { where += ' AND e.billing_cycle_date = ?'; params.push(cycle); }
  if (status) { where += ' AND e.status = ?'; params.push(status); }
  if (personnel_id) { where += ' AND e.personnel_id = ?'; params.push(parseInt(personnel_id)); }
  if (from) { where += ' AND e.sale_date >= ?'; params.push(from); }
  if (to) { where += ' AND e.sale_date <= ?'; params.push(to); }

  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM entries e JOIN users u ON u.id = e.personnel_id ${where}`).get(...params);
  const total = totalRow.c;
  const data = db.prepare(`
    SELECT e.*, u.full_name as personnel_name, u.username as personnel_username,
      (SELECT COUNT(*) FROM attachments WHERE entry_id = e.id) as attachment_count
    FROM entries e
    JOIN users u ON u.id = e.personnel_id
    ${where}
    ORDER BY e.billing_cycle_date DESC, e.sale_date DESC, e.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  res.json({ data, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

app.post('/api/admin/entries', authRequired, adminRequired, (req, res) => {
  const { personnel_id, sale_date, description, sale_amount, commission_rate, status, notes, drive_link, billing_cycle_date, customer_name, deductions, bonuses } = req.body || {};
  if (!personnel_id || !sale_date || !description || sale_amount == null) return res.status(400).json({ error: 'Missing required fields' });
  const sale = parseFloat(sale_amount);
  if (isNaN(sale) || sale < 0 || sale > 1e9) return res.status(400).json({ error: 'Invalid sale amount' });
  const p = db.prepare("SELECT id, default_commission_rate FROM users WHERE id = ? AND role='personnel'").get(parseInt(personnel_id));
  if (!p) return res.status(400).json({ error: 'Personnel not found' });
  const rate = commission_rate != null ? parseInt(commission_rate) : (p.default_commission_rate || 70);
  if (![30, 70].includes(rate)) return res.status(400).json({ error: 'Rate must be 30 or 70' });
  const ded = safeNumber(deductions, 0);
  const bon = safeNumber(bonuses, 0);
  const commission = computeCommission(sale, rate, ded, bon);
  const result = db.prepare(`
    INSERT INTO entries (personnel_id, sale_date, description, sale_amount, commission_rate, commission_amount, status, billing_cycle_date, notes, drive_link, customer_name, deductions, bonuses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.id, sale_date, description.trim(), sale, rate, commission, status || 'pending',
         billing_cycle_date || getCycleFridayInclusive(), notes?.trim() || null,
         drive_link?.trim() || null, customer_name?.trim() || null, ded, bon);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(result.lastInsertRowid);
  audit(req, 'entry.created_by_admin', 'entry', entry.id, { personnel_id: p.id, sale_amount: sale, commission_amount: commission });
  invalidateStats();
  res.json(entry);
});

app.patch('/api/admin/entries/:id', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const { status, commission_rate, notes, billing_cycle_date, sale_amount, sale_date, description, drive_link, customer_name, deductions, bonuses } = req.body || {};
  if (status && !['pending', 'paid', 'unpaid'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const newRate = commission_rate != null ? parseInt(commission_rate) : entry.commission_rate;
  if (![30, 70].includes(newRate)) return res.status(400).json({ error: 'Rate must be 30 or 70' });
  const newSale = sale_amount != null ? parseFloat(sale_amount) : entry.sale_amount;
  if (isNaN(newSale) || newSale < 0 || newSale > 1e9) return res.status(400).json({ error: 'Invalid sale amount' });
  const ded = deductions != null ? safeNumber(deductions, 0) : entry.deductions || 0;
  const bon = bonuses != null ? safeNumber(bonuses, 0) : entry.bonuses || 0;
  const newCommission = computeCommission(newSale, newRate, ded, bon);
  db.prepare(`
    UPDATE entries SET status = COALESCE(?, status), commission_rate = ?, sale_amount = ?, commission_amount = ?,
      sale_date = COALESCE(?, sale_date), description = COALESCE(?, description),
      drive_link = COALESCE(?, drive_link), notes = COALESCE(?, notes),
      customer_name = COALESCE(?, customer_name),
      deductions = ?, bonuses = ?,
      billing_cycle_date = COALESCE(?, billing_cycle_date), updated_at = datetime('now')
    WHERE id = ?
  `).run(status || null, newRate, newSale, newCommission, sale_date || null, description?.trim() || null,
         drive_link != null ? drive_link.trim() : null, notes != null ? notes.trim() : null,
         customer_name != null ? customer_name.trim() : null, ded, bon,
         billing_cycle_date || null, id);
  audit(req, 'entry.verified', 'entry', id, {
    status_from: entry.status, status_to: status || entry.status,
    rate_from: entry.commission_rate, rate_to: newRate,
    commission_to: newCommission
  });
  // Queue notification if status changed to paid
  if (status === 'paid' && entry.status !== 'paid') {
    queueNotification(entry.personnel_id, 'commission.paid', 'Your commission was paid', `Your commission of $${newCommission.toFixed(2)} for "${entry.description}" was marked as paid.`, 'entry', id);
  }
  invalidateStats();
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
});

app.delete('/api/admin/entries/:id', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  const entry = db.prepare('SELECT description, commission_amount FROM entries WHERE id = ?').get(id);
  deleteAttachmentFiles(id);
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  audit(req, 'entry.deleted_by_admin', 'entry', id, entry || {});
  invalidateStats();
  res.json({ ok: true });
});

// ============ ADMIN: BULK ACTIONS ============
function parseBulkIds(body) {
  const ids = (body?.ids || []).map(x => parseInt(x)).filter(x => !isNaN(x));
  if (ids.length === 0) throw new Error('No entries selected');
  if (ids.length > 500) throw new Error('Too many entries (max 500 per batch)');
  return ids;
}

app.post('/api/admin/entries/bulk-status', authRequired, adminRequired, (req, res) => {
  let ids;
  try { ids = parseBulkIds(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { status } = req.body || {};
  if (!['pending', 'paid', 'unpaid'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(
    `UPDATE entries SET status = ?, updated_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(status, ...ids);
  audit(req, 'entry.bulk_status_changed', 'entry', null, { ids, status, affected: result.changes });
  invalidateStats();
  res.json({ updated: result.changes, status });
});

app.post('/api/admin/entries/bulk-transfer', authRequired, adminRequired, (req, res) => {
  let ids;
  try { ids = parseBulkIds(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: 'A reason is required' });
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, billing_cycle_date, notes FROM entries WHERE id IN (${placeholders})`).all(...ids);
  const update = db.prepare("UPDATE entries SET billing_cycle_date = ?, status = 'pending', notes = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction((list) => {
    for (const e of list) {
      const next = nextCycleAfter(e.billing_cycle_date);
      const newNotes = prependTransferNote(e.notes, e.billing_cycle_date, next, note.trim());
      update.run(next, newNotes, e.id);
    }
  })(rows);
  audit(req, 'entry.bulk_transferred', 'entry', null, { ids, count: rows.length, reason: note.trim() });
  invalidateStats();
  res.json({ moved: rows.length });
});

app.post('/api/admin/entries/bulk-delete', authRequired, adminRequired, (req, res) => {
  let ids;
  try { ids = parseBulkIds(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const placeholders = ids.map(() => '?').join(',');
  for (const id of ids) deleteAttachmentFiles(id);
  const result = db.prepare(`DELETE FROM entries WHERE id IN (${placeholders})`).run(...ids);
  audit(req, 'entry.bulk_deleted', 'entry', null, { ids, deleted: result.changes });
  invalidateStats();
  res.json({ deleted: result.changes });
});

app.post('/api/admin/entries/:id/transfer', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const { note } = req.body || {};
  if (!note?.trim()) return res.status(400).json({ error: 'A reason is required to move an entry' });
  const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const next = nextCycleAfter(entry.billing_cycle_date);
  const newNotes = prependTransferNote(entry.notes, entry.billing_cycle_date, next, note.trim());
  db.prepare("UPDATE entries SET billing_cycle_date = ?, status = 'pending', notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, newNotes, id);
  audit(req, 'entry.transferred', 'entry', id, { from: entry.billing_cycle_date, to: next, reason: note.trim() });
  invalidateStats();
  res.json(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));
});

app.post('/api/admin/transfer-unpaid', authRequired, adminRequired, (req, res) => {
  const { cycle, note } = req.body || {};
  if (!cycle) return res.status(400).json({ error: 'Missing cycle' });
  if (!note?.trim()) return res.status(400).json({ error: 'A reason is required' });
  const next = nextCycleAfter(cycle);
  const rows = db.prepare("SELECT id, notes FROM entries WHERE billing_cycle_date = ? AND status != 'paid'").all(cycle);
  const update = db.prepare("UPDATE entries SET billing_cycle_date = ?, status = 'pending', notes = ?, updated_at = datetime('now') WHERE id = ?");
  db.transaction((list) => {
    for (const e of list) update.run(next, prependTransferNote(e.notes, cycle, next, note.trim()), e.id);
  })(rows);
  audit(req, 'entry.cycle_rollover', 'entry', null, { cycle_from: cycle, cycle_to: next, count: rows.length, reason: note.trim() });
  invalidateStats();
  res.json({ moved: rows.length, nextCycle: next });
});

// ============ ADMIN: PERSONNEL ============
app.get('/api/admin/personnel', authRequired, adminRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.default_commission_rate, u.active, u.created_at,
      COALESCE(SUM(e.sale_amount), 0) as total_sales,
      COALESCE(SUM(e.commission_amount), 0) as total_commission,
      COALESCE(SUM(CASE WHEN e.status='paid' THEN e.commission_amount ELSE 0 END), 0) as total_paid,
      COALESCE(SUM(CASE WHEN e.status!='paid' THEN e.commission_amount ELSE 0 END), 0) as total_pending,
      COUNT(e.id) as entry_count
    FROM users u LEFT JOIN entries e ON e.personnel_id = u.id
    WHERE u.role = 'personnel'
    GROUP BY u.id ORDER BY u.full_name
  `).all();
  res.json(rows);
});

app.post('/api/admin/personnel', authRequired, adminRequired, (req, res) => {
  const { username, password, full_name, default_commission_rate } = req.body || {};
  if (!username || !password || !full_name) return res.status(400).json({ error: 'Missing fields' });
  if (String(username).length > 50 || String(full_name).length > 100) return res.status(400).json({ error: 'Field too long' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });
  const rate = parseInt(default_commission_rate) || 70;
  if (![30, 70].includes(rate)) return res.status(400).json({ error: 'Rate must be 30 or 70' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    const r = db.prepare(`
      INSERT INTO users (username, password_hash, role, full_name, default_commission_rate)
      VALUES (?, ?, 'personnel', ?, ?)
    `).run(String(username).trim(), hash, String(full_name).trim(), rate);
    audit(req, 'personnel.created', 'user', r.lastInsertRowid, { username, full_name, default_commission_rate: rate });
    invalidateStats();
    res.json({ id: r.lastInsertRowid, username, full_name, default_commission_rate: rate, active: 1 });
  } catch (e) {
    res.status(400).json({ error: e.message.includes('UNIQUE') ? 'Username already exists' : e.message });
  }
});

app.patch('/api/admin/personnel/:id', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const { full_name, default_commission_rate, active, password } = req.body || {};
  const updates = [], params = [];
  if (full_name != null) { updates.push('full_name = ?'); params.push(String(full_name).trim()); }
  if (default_commission_rate != null) {
    const rate = parseInt(default_commission_rate);
    if (![30, 70].includes(rate)) return res.status(400).json({ error: 'Rate must be 30 or 70' });
    updates.push('default_commission_rate = ?'); params.push(rate);
  }
  if (active != null) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (password) {
    if (String(password).length < 4) return res.status(400).json({ error: 'Password too short' });
    updates.push('password_hash = ?'); params.push(bcrypt.hashSync(password, 10));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(id);
  const result = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ? AND role = 'personnel'`).run(...params);
  if (!result.changes) return res.status(404).json({ error: 'Personnel not found' });
  const action = password ? 'personnel.password_reset'
    : (active != null ? (active ? 'personnel.activated' : 'personnel.deactivated') : 'personnel.updated');
  audit(req, action, 'user', id, { fields: Object.keys(req.body || {}).filter(k => k !== 'password') });
  invalidateStats();
  res.json(db.prepare('SELECT id, username, full_name, default_commission_rate, active FROM users WHERE id = ?').get(id));
});

// ============ ADMIN: STATS / REPORTS ============
app.get('/api/admin/stats', authRequired, adminRequired, (req, res) => {
  // Cached for 60s to absorb dashboard refresh storms
  if (statsCache.value && statsCache.expiresAt > Date.now()) {
    return res.json(statsCache.value);
  }
  const currentCycle = getCycleFridayInclusive();
  const prevCycle = prevCycleBefore(currentCycle);
  const cycleStats = (cy) => db.prepare(`
    SELECT
      COALESCE(SUM(sale_amount), 0) as sales,
      COALESCE(SUM(commission_amount), 0) as commission,
      COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END), 0) as paidCommission,
      COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END), 0) as pendingCommission,
      COALESCE(SUM(CASE WHEN status='unpaid' THEN commission_amount ELSE 0 END), 0) as unpaidCommission,
      COUNT(*) as entryCount
    FROM entries WHERE billing_cycle_date = ?
  `).get(cy);
  const current = cycleStats(currentCycle);
  const prev = cycleStats(prevCycle);
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(sale_amount), 0) as totalSales,
      COALESCE(SUM(commission_amount), 0) as totalCommission,
      COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END), 0) as totalPaid,
      COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END), 0) as totalPending,
      COALESCE(SUM(CASE WHEN status='unpaid' THEN commission_amount ELSE 0 END), 0) as totalUnpaid,
      COUNT(*) as totalEntries
    FROM entries
  `).get();
  const pendingCount = db.prepare("SELECT COUNT(*) as c FROM entries WHERE status='pending'").get().c;
  const activePersonnel = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='personnel' AND active=1").get().c;
  const cycles = lastNCycles(8);
  const ph = cycles.map(() => '?').join(',');
  const trendRows = db.prepare(`
    SELECT billing_cycle_date as cycle,
      COALESCE(SUM(commission_amount), 0) as commission,
      COALESCE(SUM(sale_amount), 0) as sales,
      COUNT(*) as entry_count
    FROM entries WHERE billing_cycle_date IN (${ph}) GROUP BY billing_cycle_date
  `).all(...cycles);
  const map = Object.fromEntries(trendRows.map(r => [r.cycle, r]));
  const weeklyTrend = cycles.map(c => ({
    cycle: c, commission: map[c]?.commission || 0, sales: map[c]?.sales || 0, entry_count: map[c]?.entry_count || 0
  }));
  const statusBreakdown = db.prepare(`
    SELECT status, COUNT(*) as count, COALESCE(SUM(commission_amount),0) as amount
    FROM entries WHERE billing_cycle_date = ? GROUP BY status
  `).all(currentCycle);
  const leaderboard = db.prepare(`
    SELECT u.id as personnel_id, u.full_name,
      COALESCE(SUM(e.commission_amount), 0) as commission,
      COALESCE(SUM(e.sale_amount), 0) as sales,
      COUNT(e.id) as entry_count
    FROM users u LEFT JOIN entries e ON e.personnel_id = u.id AND e.billing_cycle_date = ?
    WHERE u.role = 'personnel' AND u.active = 1
    GROUP BY u.id ORDER BY commission DESC LIMIT 5
  `).all(currentCycle);
  const payload = { currentCycle, prevCycle, currentCycleStats: current, prevCycleStats: prev, totals, pendingCount, activePersonnel, weeklyTrend, statusBreakdown, leaderboard };
  statsCache.value = payload;
  statsCache.expiresAt = Date.now() + 60_000;
  res.json(payload);
});

app.get('/api/admin/reports', authRequired, adminRequired, (req, res) => {
  const { period = 'weekly' } = req.query;
  let group;
  if (period === 'weekly') group = 'billing_cycle_date';
  else if (period === 'monthly') group = "substr(billing_cycle_date,1,7)";
  else if (period === 'yearly') group = "substr(billing_cycle_date,1,4)";
  else return res.status(400).json({ error: 'Invalid period' });
  const rows = db.prepare(`
    SELECT ${group} as period, COUNT(*) as entry_count,
      COALESCE(SUM(sale_amount), 0) as total_sales,
      COALESCE(SUM(commission_amount), 0) as total_commission,
      COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END), 0) as paid_commission,
      COALESCE(SUM(CASE WHEN status='unpaid' THEN commission_amount ELSE 0 END), 0) as unpaid_commission,
      COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END), 0) as pending_commission
    FROM entries GROUP BY ${group} ORDER BY period DESC
  `).all();
  res.json(rows);
});

app.get('/api/admin/reports/export', authRequired, adminRequired, (req, res) => {
  const { from, to, cycle, status, personnel_id } = req.query;
  let q = `
    SELECT u.full_name as personnel, u.username, e.sale_date, e.description, e.sale_amount,
      e.commission_rate, e.commission_amount, e.billing_cycle_date, e.status, e.notes, e.drive_link, e.created_at
    FROM entries e JOIN users u ON u.id = e.personnel_id WHERE 1=1
  `;
  const p = [];
  if (cycle) { q += ' AND e.billing_cycle_date = ?'; p.push(cycle); }
  if (status) { q += ' AND e.status = ?'; p.push(status); }
  if (personnel_id) { q += ' AND e.personnel_id = ?'; p.push(parseInt(personnel_id)); }
  if (from) { q += ' AND e.sale_date >= ?'; p.push(from); }
  if (to) { q += ' AND e.sale_date <= ?'; p.push(to); }
  q += ' ORDER BY e.billing_cycle_date DESC, e.sale_date DESC';
  const rows = db.prepare(q).all(...p);
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const headers = ['Personnel','Username','Sale Date','Description','Sale Amount','Rate %','Commission','Billing Cycle','Status','Notes','Drive Link','Created'];
  const lines = [headers.join(',')];
  for (const r of rows) lines.push([r.personnel, r.username, r.sale_date, r.description, r.sale_amount, r.commission_rate, r.commission_amount, r.billing_cycle_date, r.status, r.notes, r.drive_link, r.created_at].map(esc).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="commission-report-${toYMD(new Date())}.csv"`);
  res.send('﻿' + lines.join('\r\n'));  // BOM for Excel UTF-8
});

// ============ AUDIT LOG (read) ============
// ============ PAY SUMMARY (personnel) ============
app.get('/api/personnel/me/pay-summary', authRequired, (req, res) => {
  const uid = req.user.id;
  const currentCycle = getCycleFridayInclusive();

  const upcomingPayout = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(commission_amount), 0) as total
    FROM entries
    WHERE personnel_id = ? AND billing_cycle_date = ? AND status != 'unpaid'
  `).get(uid, currentCycle);

  const lifetimeTotals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status='paid' THEN commission_amount ELSE 0 END), 0) as paid,
      COALESCE(SUM(CASE WHEN status='pending' THEN commission_amount ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN status='unpaid' THEN commission_amount ELSE 0 END), 0) as unpaid
    FROM entries WHERE personnel_id = ?
  `).get(uid);

  const payHistory = db.prepare(`
    SELECT billing_cycle_date as cycle,
      COUNT(*) as count,
      COALESCE(SUM(commission_amount), 0) as total
    FROM entries
    WHERE personnel_id = ? AND status = 'paid'
    GROUP BY billing_cycle_date
    ORDER BY billing_cycle_date DESC
    LIMIT 12
  `).all(uid);

  const cycleEntries = db.prepare(`
    SELECT id, sale_date, description, sale_amount, commission_rate, commission_amount, status, deductions, bonuses, customer_name
    FROM entries
    WHERE personnel_id = ? AND billing_cycle_date = ?
    ORDER BY sale_date DESC, id DESC
  `).all(uid, currentCycle);

  const yearStart = new Date().getFullYear() + '-01-01';
  const ytd = db.prepare(`
    SELECT COALESCE(SUM(commission_amount), 0) as total
    FROM entries WHERE personnel_id = ? AND status='paid' AND billing_cycle_date >= ?
  `).get(uid, yearStart).total;

  res.json({ currentCycle, upcomingPayout, lifetimeTotals, payHistory, cycleEntries, ytd });
});

// ============ FRIDAY DIGEST (admin) ============
app.get('/api/admin/friday-digest', authRequired, adminRequired, (req, res) => {
  const currentCycle = getCycleFridayInclusive();
  const pendingToVerify = db.prepare(`
    SELECT COUNT(*) as c, COALESCE(SUM(commission_amount), 0) as total
    FROM entries WHERE billing_cycle_date = ? AND status = 'pending'
  `).get(currentCycle);

  const totalPayout = db.prepare(`
    SELECT COALESCE(SUM(commission_amount), 0) as total
    FROM entries WHERE billing_cycle_date = ? AND status = 'paid'
  `).get(currentCycle).total;

  const topPerformer = db.prepare(`
    SELECT u.full_name, COALESCE(SUM(e.commission_amount), 0) as total, COUNT(e.id) as entry_count
    FROM users u LEFT JOIN entries e ON e.personnel_id = u.id AND e.billing_cycle_date = ?
    WHERE u.role = 'personnel' AND u.active = 1
    GROUP BY u.id
    ORDER BY total DESC
    LIMIT 1
  `).get(currentCycle);

  const newPersonnelEntries = db.prepare(`
    SELECT COUNT(*) as c FROM entries WHERE created_at >= datetime('now', '-7 days')
  `).get().c;

  const isFriday = new Date().getDay() === 5;

  res.json({
    currentCycle,
    isFriday,
    pendingToVerify,
    totalPayout,
    topPerformer,
    newPersonnelEntries
  });
});

// ============ DUPLICATE DETECTION (admin) ============
app.get('/api/admin/duplicates', authRequired, adminRequired, (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 14));
  const since = new Date(); since.setDate(since.getDate() - days);
  const sinceStr = toYMD(since);

  // Group entries by (personnel + sale_amount + customer_name OR description) within date window
  const groups = db.prepare(`
    SELECT
      e.personnel_id,
      u.full_name as personnel_name,
      e.sale_amount,
      COALESCE(e.customer_name, e.description) as match_key,
      COUNT(*) as count,
      GROUP_CONCAT(e.id) as entry_ids,
      GROUP_CONCAT(e.sale_date) as sale_dates
    FROM entries e
    JOIN users u ON u.id = e.personnel_id
    WHERE e.sale_date >= ?
    GROUP BY e.personnel_id, e.sale_amount, COALESCE(e.customer_name, e.description)
    HAVING COUNT(*) > 1
    ORDER BY count DESC, e.personnel_id
  `).all(sinceStr);

  const result = groups.map(g => ({
    personnel_id: g.personnel_id,
    personnel_name: g.personnel_name,
    sale_amount: g.sale_amount,
    match_key: g.match_key,
    count: g.count,
    entry_ids: g.entry_ids.split(',').map(n => parseInt(n)),
    sale_dates: g.sale_dates.split(',')
  }));

  res.json({ window_days: days, duplicates: result });
});

// ============ NOTIFICATIONS LOG (admin) ============
app.get('/api/admin/notifications', authRequired, adminRequired, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 25));
  const total = db.prepare('SELECT COUNT(*) as c FROM notification_log').get().c;
  const data = db.prepare(`
    SELECT n.*, u.full_name as user_name, u.username
    FROM notification_log n
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize);
  res.json({ data, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

app.get('/api/personnel/me/notifications', authRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id, type, subject, body, target_type, target_id, status, created_at
    FROM notification_log WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json(rows);
});

app.get('/api/admin/audit-logs', authRequired, adminRequired, (req, res) => {
  const { action, actor_id, target_type, target_id, from, to, search } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50));
  const offset = (page - 1) * pageSize;
  let where = ' WHERE 1=1';
  const params = [];
  if (action) { where += ' AND action = ?'; params.push(action); }
  if (actor_id) { where += ' AND actor_id = ?'; params.push(parseInt(actor_id)); }
  if (target_type) { where += ' AND target_type = ?'; params.push(target_type); }
  if (target_id) { where += ' AND target_id = ?'; params.push(parseInt(target_id)); }
  if (from) { where += ' AND created_at >= ?'; params.push(from); }
  if (to) { where += ' AND created_at <= ?'; params.push(to); }
  if (search) { where += ' AND (actor_username LIKE ? OR action LIKE ? OR metadata LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  const total = db.prepare(`SELECT COUNT(*) as c FROM audit_logs ${where}`).get(...params).c;
  const data = db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);
  res.json({ data, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
});

app.get('/api/admin/audit-actions', authRequired, adminRequired, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all();
  res.json(rows.map(r => r.action));
});

app.get('/api/admin/cycles', authRequired, adminRequired, (req, res) => {
  const rows = db.prepare('SELECT DISTINCT billing_cycle_date FROM entries ORDER BY billing_cycle_date DESC').all();
  res.json(rows.map(r => r.billing_cycle_date));
});

// ============ DRIVE LINKS ============
app.get('/api/drive-links', authRequired, (req, res) => {
  res.json(db.prepare('SELECT * FROM drive_links ORDER BY created_at DESC').all());
});

app.post('/api/admin/drive-links', authRequired, adminRequired, (req, res) => {
  const { title, url, description } = req.body || {};
  if (!title || !url) return res.status(400).json({ error: 'Missing fields' });
  if (String(url).length > 2000) return res.status(400).json({ error: 'URL too long' });
  const r = db.prepare('INSERT INTO drive_links (title, url, description) VALUES (?, ?, ?)').run(title.trim(), url.trim(), description?.trim() || null);
  res.json(db.prepare('SELECT * FROM drive_links WHERE id = ?').get(r.lastInsertRowid));
});

app.patch('/api/admin/drive-links/:id', authRequired, adminRequired, (req, res) => {
  const id = parseInt(req.params.id);
  const { title, url, description } = req.body || {};
  const updates = [], p = [];
  if (title != null) { updates.push('title = ?'); p.push(title.trim()); }
  if (url != null) { updates.push('url = ?'); p.push(url.trim()); }
  if (description != null) { updates.push('description = ?'); p.push(description.trim()); }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  p.push(id);
  db.prepare(`UPDATE drive_links SET ${updates.join(', ')} WHERE id = ?`).run(...p);
  res.json(db.prepare('SELECT * FROM drive_links WHERE id = ?').get(id));
});

app.delete('/api/admin/drive-links/:id', authRequired, adminRequired, (req, res) => {
  db.prepare('DELETE FROM drive_links WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ============ HEALTH & ROUTING ============
app.get('/health', (req, res) => {
  try {
    const c = db.prepare('SELECT 1 as ok').get();
    res.json({ status: 'ok', db: c.ok === 1 ? 'ok' : 'fail', uptime: process.uptime() });
  } catch (e) { res.status(503).json({ status: 'fail', error: e.message }); }
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/personnel', (req, res) => res.sendFile(path.join(__dirname, 'public', 'personnel.html')));

// ============ 404 + ERROR HANDLER ============
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[error]', req.method, req.url, '->', err.message);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(err.status || 500).json({ error: NODE_ENV === 'production' ? 'Internal server error' : err.message });
});

// ============ START + GRACEFUL SHUTDOWN ============
const server = app.listen(PORT, () => {
  console.log(`\n=====================================================`);
  console.log(`  Solar Savings Direct — Commission Portal`);
  console.log(`  Running at http://localhost:${PORT}  (env: ${NODE_ENV})`);
  console.log(`  Default admin login — username: admin  password: admin123`);
  console.log(`=====================================================\n`);
});

// HTTP timeouts to bound resource usage under load / slow clients
server.requestTimeout = 30_000;       // 30s for whole request
server.headersTimeout = 35_000;       // must be > requestTimeout
server.keepAliveTimeout = 65_000;     // align with typical proxy settings

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[server] Port ${PORT} is already in use.`);
    console.error(`[server] Another process is listening on it. Stop it first, or run with a different port:`);
    console.error(`[server]   PORT=3002 npm start\n`);
  } else {
    console.error('[server]', err.message);
  }
  process.exit(1);
});

function shutdown(sig) {
  console.log(`\n[${sig}] Shutting down gracefully...`);
  server.close(() => {
    try { db.close(); } catch {}
    console.log('[shutdown] Done.');
    process.exit(0);
  });
  setTimeout(() => { console.error('[shutdown] Forced exit'); process.exit(1); }, 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { console.error('[uncaught]', e); shutdown('uncaughtException'); });
process.on('unhandledRejection', (e) => { console.error('[unhandled]', e); });
