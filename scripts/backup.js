#!/usr/bin/env node
/**
 * Creates a zip-less, self-contained backup of the data folder by copying
 * `data/` to `backups/<timestamp>/` (atomic per file, safe to run while server is up
 * because better-sqlite3 in WAL mode handles read-during-write).
 *
 * Run with:    npm run backup
 * Restore with: stop server → copy backup contents to data/ → start server
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_ROOT = path.join(ROOT, 'backups');

function ts() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

if (!fs.existsSync(DATA_DIR)) {
  console.error('[backup] No data/ folder found — nothing to back up.');
  process.exit(1);
}

const target = path.join(BACKUP_ROOT, ts());
fs.mkdirSync(BACKUP_ROOT, { recursive: true });
console.log(`[backup] Copying data/ → ${target}`);
copyRecursive(DATA_DIR, target);

const size = dirSize(target);
console.log(`[backup] Done. ${(size / 1024 / 1024).toFixed(2)} MB at ${target}`);

// Retention: keep latest 14 backups
const backups = fs.readdirSync(BACKUP_ROOT).filter(n => /\d{4}-\d{2}-\d{2}T/.test(n)).sort();
const KEEP = 14;
if (backups.length > KEEP) {
  const old = backups.slice(0, backups.length - KEEP);
  for (const b of old) {
    const p = path.join(BACKUP_ROOT, b);
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[backup] Pruned old backup: ${b}`);
  }
}
