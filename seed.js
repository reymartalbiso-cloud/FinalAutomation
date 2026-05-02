const bcrypt = require('bcryptjs');
const db = require('./db');

function toYMD(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return toYMD(d); }
function currentCycleFriday() {
  const d = new Date();
  const diff = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  return toYMD(d);
}

console.log('[seed] Clearing existing non-admin data...');
db.prepare('DELETE FROM entries').run();
db.prepare("DELETE FROM users WHERE role='personnel'").run();
db.prepare('DELETE FROM drive_links').run();

console.log('[seed] Creating personnel accounts...');
const personnel = [
  { username: 'juan',   password: 'juan123',   full_name: 'Juan Dela Cruz',       rate: 70 },
  { username: 'maria',  password: 'maria123',  full_name: 'Maria Santos',         rate: 30 },
  { username: 'carlos', password: 'carlos123', full_name: 'Carlos Reyes',         rate: 70 },
  { username: 'ana',    password: 'ana123',    full_name: 'Ana Lopez',            rate: 30 }
];

const pIds = {};
for (const p of personnel) {
  const r = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, default_commission_rate)
    VALUES (?, ?, 'personnel', ?, ?)
  `).run(p.username, bcrypt.hashSync(p.password, 10), p.full_name, p.rate);
  pIds[p.username] = r.lastInsertRowid;
}

console.log('[seed] Creating site surveyor account...');
const surveyors = [
  { username: 'mike', password: 'mike123', full_name: 'Mike Thompson' }
];
const sIds = {};
for (const s of surveyors) {
  const r = db.prepare(`
    INSERT INTO users (username, password_hash, role, full_name, default_commission_rate)
    VALUES (?, ?, 'surveyor', ?, 0)
  `).run(s.username, bcrypt.hashSync(s.password, 10), s.full_name);
  sIds[s.username] = r.lastInsertRowid;
}

console.log('[seed] Adding drive links...');
const links = [
  { title: 'Q2 2026 Verification Photos',  url: 'https://drive.google.com/drive/folders/example-q2-2026', description: 'Receipts & proof-of-sale photos for the current quarter' },
  { title: 'Product Catalog & Pricing',    url: 'https://drive.google.com/file/d/example-catalog',       description: 'Master catalog with current prices and SKUs' },
  { title: 'Commission Policy Document',   url: 'https://drive.google.com/file/d/example-policy',        description: 'Details on 70% vs 30% rate criteria' }
];
for (const l of links) {
  db.prepare('INSERT INTO drive_links (title, url, description) VALUES (?, ?, ?)').run(l.title, l.url, l.description);
}

console.log('[seed] Generating entries across cycles...');
const currentCycle = currentCycleFriday();
const cycles = [
  addDays(currentCycle, -42),
  addDays(currentCycle, -35),
  addDays(currentCycle, -28),
  addDays(currentCycle, -21),
  addDays(currentCycle, -14),
  addDays(currentCycle, -7),
  currentCycle
];

const products = [
  'Residential Solar — 8kW system',
  'Residential Solar — 12kW system',
  'Residential Solar — 6kW system + battery',
  'Tesla Powerwall 3 install',
  'Tesla Powerwall 3 (x2) install',
  'Commercial rooftop — 40kW',
  'Roof replacement + solar',
  'Battery backup add-on',
  'Solar + EV charger package',
  'Off-grid system — cabin',
  'Energy audit & proposal',
  'Referral — closed sale',
  'System monitoring upgrade',
  'Inverter replacement',
  'Microinverter upgrade',
  'Net metering enrollment',
  'Equipment financing — solar loan',
  'Warranty extension package'
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function money(min, max) { return Math.round((Math.random() * (max - min) + min) / 100) * 100; }

let totalEntries = 0;
for (let ci = 0; ci < cycles.length; ci++) {
  const cycle = cycles[ci];
  const isOld = ci < cycles.length - 2;
  const isCurrent = ci === cycles.length - 1;

  const entriesThisCycle = isCurrent ? 5 : isOld ? 3 + Math.floor(Math.random() * 3) : 4 + Math.floor(Math.random() * 3);

  for (let i = 0; i < entriesThisCycle; i++) {
    const who = personnel[Math.floor(Math.random() * personnel.length)];
    const personnelId = pIds[who.username];
    const rate = Math.random() < 0.75 ? who.rate : (who.rate === 70 ? 30 : 70);
    const saleAmount = money(2500, 28000);
    const commission = (saleAmount * rate) / 100;
    const saleDate = addDays(cycle, -1 * Math.floor(Math.random() * 5) - 1);

    let status;
    if (isCurrent) status = Math.random() < 0.8 ? 'pending' : (Math.random() < 0.5 ? 'paid' : 'unpaid');
    else if (isOld) status = Math.random() < 0.85 ? 'paid' : 'unpaid';
    else status = Math.random() < 0.7 ? 'paid' : (Math.random() < 0.5 ? 'unpaid' : 'pending');

    const hasDriveLink = Math.random() < 0.35;
    const hasNotes = Math.random() < 0.3;
    const notes = hasNotes ? pick(['Rush order', 'Repeat customer', 'Needs follow-up', 'Verified via invoice', 'Paid in full', 'Partial payment received', 'Referred by existing client']) : null;
    const driveLink = hasDriveLink ? `https://drive.google.com/drive/folders/sample-${Math.floor(Math.random()*100000)}` : null;

    const hasDeduction = Math.random() < 0.2;
    const hasBonus = Math.random() < 0.15;
    const deductions = hasDeduction ? Math.round(saleAmount * 0.05 / 100) * 100 : 0;
    const bonuses = hasBonus ? money(100, 800) : 0;
    const base = Math.max(0, saleAmount - deductions);
    const finalCommission = (base * rate) / 100 + bonuses;
    const customers = ['Smith Family', 'Garcia Residence', 'Patel Home', 'Johnson Property', 'Lee Family Farm', 'Walker Estate', 'Nguyen Household', 'Ali Family', 'Anderson Ranch', null];
    const customer = pick(customers);
    // 60% of older entries already site-visited; current cycle entries mostly pending
    let siteStatus = 'pending';
    let siteNotes = null, siteAdjustment = 0, siteAdjustReason = null, siteVisitedBy = null, siteVisitedAt = null;
    const visitChance = isCurrent ? 0.2 : 0.7;
    if (Math.random() < visitChance) {
      siteStatus = 'completed';
      siteVisitedBy = sIds.mike;
      const dayOffset = Math.floor(Math.random() * 5);
      siteVisitedAt = new Date(new Date(saleDate + 'T00:00:00').getTime() + dayOffset * 86400000).toISOString();
      const sampleNotes = [
        'Roof in good condition. Standard install. No issues.',
        'South-facing roof, shading is minimal. Good site.',
        'Older roof — recommend customer reinforce before install.',
        'Tight access for installation crew, plan for extra time.',
        'Electrical panel needs upgrade to 200A before install.',
        'Customer asked for additional EV charger circuit.',
        'Tree trimming needed on east side. Coordinated with customer.'
      ];
      siteNotes = pick(sampleNotes);
      if (Math.random() < 0.3) {
        siteAdjustment = pick([500, 800, 1200, 1500, 2000]);
        siteAdjustReason = pick(['Roof reinforcement', 'Panel upgrade', 'Tree trimming', 'Additional circuit', 'Trenching surcharge']);
      }
    }
    db.prepare(`
      INSERT INTO entries (personnel_id, sale_date, description, sale_amount, commission_rate, commission_amount, status, billing_cycle_date, notes, drive_link, customer_name, deductions, bonuses, site_visit_status, site_visit_notes, site_adjustment, site_adjustment_reason, site_visited_by, site_visited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(personnelId, saleDate, pick(products), saleAmount, rate, finalCommission, status, cycle, notes, driveLink, customer, deductions, bonuses, siteStatus, siteNotes, siteAdjustment, siteAdjustReason, siteVisitedBy, siteVisitedAt);
    totalEntries++;
  }
}

console.log(`\n===== SEED COMPLETE =====`);
console.log(`  Personnel created: ${personnel.length}`);
console.log(`  Drive links:       ${links.length}`);
console.log(`  Entries:           ${totalEntries} across ${cycles.length} cycles`);
console.log(`\n  Admin login:    admin / admin123`);
console.log(`  Personnel logins:`);
for (const p of personnel) console.log(`    ${p.full_name.padEnd(20)} ${p.username} / ${p.password}  (default rate ${p.rate}%)`);
console.log(`  Site Surveyor logins:`);
for (const s of surveyors) console.log(`    ${s.full_name.padEnd(20)} ${s.username} / ${s.password}`);
console.log(`=========================\n`);
