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
// The actual delete logic lives in lib/resetConceptsAndStyles.js, shared
// with the in-app "Danger Zone" reset button (routes/adminReset.js) so both
// entry points can never drift apart.
//
// Take a fresh backup first if you want extra peace of mind beyond the
// nightly backup-to-staging.sh snapshot.

const { db } = require('../db');
const { getResetCounts, performReset } = require('../lib/resetConceptsAndStyles');

const confirm = process.argv.includes('--confirm');
const counts = getResetCounts(db);

console.log('This will permanently delete:');
Object.entries(counts).forEach(([table, n]) => console.log(`  ${table}: ${n} row${n === 1 ? '' : 's'}`));
console.log('\nKept untouched: users, contacts, factories, fabrics, fabric_test_reports, spec_categories, size_ranges, containers.\n');

if (!confirm) {
  console.log('Dry run only - nothing deleted. Re-run with --confirm to actually delete.');
  process.exit(0);
}

const result = performReset(db);
console.log(`Done. Deleted ${result.filesDeleted} files and ${result.foldersDeleted} final-submission folders from disk.`);
