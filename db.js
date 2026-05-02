const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','personnel','surveyor')),
    full_name TEXT NOT NULL,
    default_commission_rate INTEGER DEFAULT 70,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    personnel_id INTEGER NOT NULL,
    sale_date TEXT NOT NULL,
    description TEXT NOT NULL,
    sale_amount REAL NOT NULL,
    commission_rate INTEGER NOT NULL DEFAULT 70,
    commission_amount REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','unpaid')),
    billing_cycle_date TEXT NOT NULL,
    notes TEXT,
    drive_link TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (personnel_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS drive_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    uploaded_by INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER,
    actor_username TEXT,
    actor_role TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    metadata TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','failed','skipped')),
    sent_at TEXT,
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_entries_personnel ON entries(personnel_id);
  CREATE INDEX IF NOT EXISTS idx_entries_cycle ON entries(billing_cycle_date);
  CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
  CREATE INDEX IF NOT EXISTS idx_entries_sale_date ON entries(sale_date);
  CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
  CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_id);
  CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notification_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_notif_status ON notification_log(status);
`);

// ===== Migrations: add columns if missing =====
function columnExists(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!columnExists('entries', 'deductions')) {
  db.exec("ALTER TABLE entries ADD COLUMN deductions REAL NOT NULL DEFAULT 0");
}
if (!columnExists('entries', 'bonuses')) {
  db.exec("ALTER TABLE entries ADD COLUMN bonuses REAL NOT NULL DEFAULT 0");
}
if (!columnExists('entries', 'customer_name')) {
  db.exec("ALTER TABLE entries ADD COLUMN customer_name TEXT");
}
if (!columnExists('users', 'email')) {
  db.exec("ALTER TABLE users ADD COLUMN email TEXT");
}
if (!columnExists('users', 'phone')) {
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
}

// Site visit fields on entries
if (!columnExists('entries', 'site_visit_status')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_visit_status TEXT NOT NULL DEFAULT 'pending'");
}
if (!columnExists('entries', 'site_visit_notes')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_visit_notes TEXT");
}
if (!columnExists('entries', 'site_adjustment')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_adjustment REAL NOT NULL DEFAULT 0");
}
if (!columnExists('entries', 'site_adjustment_reason')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_adjustment_reason TEXT");
}
if (!columnExists('entries', 'site_visited_by')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_visited_by INTEGER");
}
if (!columnExists('entries', 'site_visited_at')) {
  db.exec("ALTER TABLE entries ADD COLUMN site_visited_at TEXT");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_entries_visit_status ON entries(site_visit_status)");

// One-time migration: extend users.role CHECK constraint to allow 'surveyor'
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
if (!usersSql.includes("'surveyor'")) {
  console.log("[migrate] Extending users table to allow 'surveyor' role...");
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
      const hasEmail = cols.includes('email');
      const hasPhone = cols.includes('phone');
      const extraDef = (hasEmail ? ',\n          email TEXT' : '') + (hasPhone ? ',\n          phone TEXT' : '');
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','personnel','surveyor')),
          full_name TEXT NOT NULL,
          default_commission_rate INTEGER DEFAULT 70,
          active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now'))${extraDef}
        )
      `);
      const copyCols = ['id','username','password_hash','role','full_name','default_commission_rate','active','created_at']
        .concat(hasEmail ? ['email'] : [])
        .concat(hasPhone ? ['phone'] : []);
      db.exec(`INSERT INTO users_new (${copyCols.join(',')}) SELECT ${copyCols.join(',')} FROM users`);
      db.exec(`DROP TABLE users`);
      db.exec(`ALTER TABLE users_new RENAME TO users`);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

const adminCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c;
if (adminCount === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare("INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'admin', ?)")
    .run('admin', hash, 'Administrator');
  console.log("[seed] Default admin created — username: admin  password: admin123");
}

module.exports = db;
