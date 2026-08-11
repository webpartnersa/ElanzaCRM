// Wipes every concept, style, and order (plus everything that hangs off
// them - photos, comments, spec/fit records, factory-cost/quotation
// requests, fabric-report links, final-submission docs) so the CRM can be
// used fresh. Deliberately KEEPS users, contacts, factories, fabrics
// (including their lab test reports), spec categories, size ranges, and
// containers - those are reference/structural data, not per-concept/style
// records, and stay untouched.
//
// Safe by default: run with no flags and it only PRINTS what it would
// delete. Nothing is touched until you pass --confirm.
//
//   node scripts/reset-concepts-and-styles.js            (dry run - counts only)
//   node scripts/reset-concepts-and-styles.js --confirm   (actually deletes)
//
// Take a fresh backup first if you want extra peace of mind beyond the
// nightly backup-to-staging.sh snapshot - see uploads/backups conventions
// elsewhere on this droplet.

const fs = require('fs');
const path = require('path');
const { db } = require('../db');

const ROOT = path.join(__dirname, '..');
const PRIVATE_SUBMISSION_DIR = path.join(ROOT, 'private', 'final-submission');

function resolveWebPath(relPath) {
  if (!relPath) return null;
  return path.join(ROOT, relPath.replace(/^\/+/, ''));
}

function safeUnlink(fullPath) {
  if (!fullPath) return;
  try { fs.unlinkSync(fullPath); } catch (e) { /* already gone / never existed - fine */ }
}

function safeSegment(v, fallback) {
  return (v || fallback || '').toString().trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || fallback;
}

const confirm = process.argv.includes('--confirm');

const counts = {
  concepts: db.prepare('SELECT COUNT(*) c FROM concepts').get().c,
  concept_photos: db.prepare('SELECT COUNT(*) c FROM concept_photos').get().c,
  concept_conversions: db.prepare('SELECT COUNT(*) c FROM concept_conversions').get().c,
  concept_requests: db.prepare('SELECT COUNT(*) c FROM concept_requests').get().c,
  styles: db.prepare('SELECT COUNT(*) c FROM styles').get().c,
  photos: db.prepare('SELECT COUNT(*) c FROM photos').get().c,
  comments: db.prepare('SELECT COUNT(*) c FROM comments').get().c,
  style_spec_poms: db.prepare('SELECT COUNT(*) c FROM style_spec_poms').get().c,
  style_spec_fits: db.prepare('SELECT COUNT(*) c FROM style_spec_fits').get().c,
  fabric_report_styles: db.prepare('SELECT COUNT(*) c FROM fabric_report_styles').get().c,
  orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  order_delays: db.prepare('SELECT COUNT(*) c FROM order_delays').get().c,
  order_submission_docs: db.prepare('SELECT COUNT(*) c FROM order_submission_docs').get().c,
};

console.log('This will permanently delete:');
Object.entries(counts).forEach(([table, n]) => console.log(`  ${table}: ${n} row${n === 1 ? '' : 's'}`));
console.log('\nKept untouched: users, contacts, factories, fabrics, fabric_test_reports, spec_categories, size_ranges, containers.\n');

if (!confirm) {
  console.log('Dry run only - nothing deleted. Re-run with --confirm to actually delete.');
  process.exit(0);
}

// Collect every file path that needs deleting from disk before the rows
// referencing them are gone.
const filesToDelete = [];
db.prepare('SELECT path, thumb_path FROM photos').all().forEach(p => {
  filesToDelete.push(resolveWebPath(p.path), resolveWebPath(p.thumb_path));
});
db.prepare('SELECT path, thumb_path FROM concept_photos').all().forEach(p => {
  filesToDelete.push(resolveWebPath(p.path), resolveWebPath(p.thumb_path));
});
db.prepare("SELECT file_path FROM style_spec_fits WHERE file_path IS NOT NULL AND file_path != ''").all().forEach(f => {
  filesToDelete.push(resolveWebPath(f.file_path));
});

// Whole per-style/order private final-submission folders.
const orderDirsToDelete = db.prepare('SELECT style_no, order_no, id FROM orders').all()
  .map(o => path.join(PRIVATE_SUBMISSION_DIR, safeSegment(o.style_no, 'style'), safeSegment(o.order_no, 'order' + o.id)));

const run = db.transaction(() => {
  db.exec('PRAGMA foreign_keys=OFF;');

  db.exec('DELETE FROM request_reminders');
  db.exec('DELETE FROM concept_requests');
  db.exec('DELETE FROM concept_conversions');
  db.exec('DELETE FROM concept_photos');
  db.exec('DELETE FROM concepts');

  db.exec('DELETE FROM order_submission_docs');
  db.exec('DELETE FROM order_delays');
  db.exec('DELETE FROM orders');

  db.exec('DELETE FROM fabric_report_styles');
  db.exec('DELETE FROM style_spec_fit_values');
  db.exec('DELETE FROM style_spec_fits');
  db.exec('DELETE FROM style_spec_poms');
  db.exec('DELETE FROM comments');
  db.exec('DELETE FROM photos');
  db.exec('DELETE FROM styles');

  db.exec('PRAGMA foreign_keys=ON;');
});

run();

filesToDelete.forEach(safeUnlink);
orderDirsToDelete.forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));

console.log(`Done. Deleted ${filesToDelete.filter(Boolean).length} files and ${orderDirsToDelete.length} final-submission folders from disk.`);
