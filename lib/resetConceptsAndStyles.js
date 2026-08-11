// Shared by scripts/reset-concepts-and-styles.js (run from a terminal) and
// routes/adminReset.js (the in-app "Danger Zone" button) - one place for
// what gets deleted and in what order, so the two entry points can never
// drift apart. See scripts/reset-concepts-and-styles.js for the full
// rationale on scope (wipes concepts/styles/orders and everything that
// hangs off them; keeps users/contacts/factories/fabrics/spec categories/
// size ranges/containers).
const fs = require('fs');
const path = require('path');

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

const COUNTED_TABLES = [
  'concepts', 'concept_photos', 'concept_conversions', 'concept_requests',
  'styles', 'photos', 'comments', 'style_spec_poms', 'style_spec_fits',
  'fabric_report_styles', 'orders', 'order_delays', 'order_submission_docs',
];

function getResetCounts(db) {
  const counts = {};
  COUNTED_TABLES.forEach(t => { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; });
  return counts;
}

// Deletes every row (see COUNTED_TABLES) plus their files on disk. Caller's
// responsibility to have already confirmed with the human on the other end
// - this function itself performs the delete unconditionally once called.
function performReset(db) {
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

  return { filesDeleted: filesToDelete.filter(Boolean).length, foldersDeleted: orderDirsToDelete.length };
}

module.exports = { getResetCounts, performReset, COUNTED_TABLES };
