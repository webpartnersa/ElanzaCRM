const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { extractFabricTestReport } = require('../lib/fabricTestReport');

const router = express.Router();
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Section-level gate: can this user reach Fabrics at all. Independent of
// role - see db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('fabrics'));

// Buyers are read-mostly everywhere else in the app and stay that way here
// too, even once granted the 'fabrics' permission.
function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
function resolveUploadPath(relPath) {
  return path.join(__dirname, '..', relPath);
}

const uploadPdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') {
      return cb(new Error('Not authorized to upload test reports'));
    }
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed'));
    cb(null, true);
  }
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM fabrics ORDER BY code ASC').all();
  res.json({ fabrics: rows });
});

// Every field a fabric can carry - the code, composition/weight, and the
// Material Submission fields (see db.js's comment on the same columns).
// Everything report-specific (report number, dates, style/buyer, validity)
// still lives per-report on fabric_test_reports instead.
const YARN_FIELDS = [1, 2, 3, 4].flatMap(n =>
  ['type', 'composition', 'spinning', 'count', 'sustainability'].map(attr => `yarn${n}_${attr}`)
);
const FABRIC_FIELDS = [
  'code', 'composition', 'weight',
  'description', 'fabric_type', 'construction', 'construction_gauge', 'finishes',
  'fabric_supplier', 'yarn_supplier', 'country_of_origin',
  ...YARN_FIELDS,
];

// Matches free-text Style No. against every existing style's style_no - can
// return more than one, since the same fabric/report is often shared across
// styles. Splits on slash/comma/semicolon ("PG054/PG061") and whitespace
// ("A:PL015-BLK B:PL015-WHITE" - a multi-sample lab report's two codes).
function matchStyleIdsFromText(text) {
  const tokens = (text || '').split(/[/,;\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!tokens.length) return [];
  const ids = db.prepare('SELECT id, style_no FROM styles').all()
    .filter(s => tokens.includes((s.style_no || '').toUpperCase()))
    .map(s => s.id);
  return [...new Set(ids)];
}

// Overwrites which styles a report is linked to, driven entirely by its
// (possibly multi-code) style_no free text - called whenever a report is
// saved so the Style drawer's Fabric Report tab always reflects it.
function relinkReportStyles(reportId, styleNoText) {
  db.prepare('DELETE FROM fabric_report_styles WHERE report_id = ?').run(reportId);
  const insert = db.prepare('INSERT OR IGNORE INTO fabric_report_styles (report_id, style_id) VALUES (?, ?)');
  matchStyleIdsFromText(styleNoText).forEach(styleId => insert.run(reportId, styleId));
}

router.post('/', blockBuyerWrite, (req, res) => {
  const { code } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: 'Fabric code is required' });
  const cols = FABRIC_FIELDS.filter(f => f !== 'code');
  const values = cols.map(f => (req.body[f] || '').toString().trim() || null);
  try {
    const info = db.prepare(`
      INSERT INTO fabrics (code, ${cols.join(', ')})
      VALUES (?, ${cols.map(()=>'?').join(', ')})
    `).run(code.trim(), ...values);
    const created = db.prepare('SELECT * FROM fabrics WHERE id = ?').get(info.lastInsertRowid);
    res.json({ fabric: created });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `Fabric code "${code}" already exists` });
    res.status(500).json({ error: 'Could not create fabric' });
  }
});

router.put('/:id', blockBuyerWrite, (req, res) => {
  const fabric = db.prepare('SELECT * FROM fabrics WHERE id = ?').get(req.params.id);
  if (!fabric) return res.status(404).json({ error: 'Fabric not found' });
  const fields = FABRIC_FIELDS;
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  try {
    db.prepare(`UPDATE fabrics SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `Fabric code "${req.body.code}" already exists` });
    return res.status(500).json({ error: 'Could not update fabric' });
  }
  const updated = db.prepare('SELECT * FROM fabrics WHERE id = ?').get(req.params.id);
  res.json({ fabric: updated });
});

router.delete('/:id', blockBuyerWrite, (req, res) => {
  const fabric = db.prepare('SELECT * FROM fabrics WHERE id = ?').get(req.params.id);
  if (!fabric) return res.status(404).json({ error: 'Fabric not found' });
  const reports = db.prepare('SELECT * FROM fabric_test_reports WHERE fabric_code = ?').all(fabric.code);
  reports.forEach(r => fs.unlink(resolveUploadPath(r.file_path), () => {}));
  db.prepare('DELETE FROM fabric_report_styles WHERE report_id IN (SELECT id FROM fabric_test_reports WHERE fabric_code = ?)').run(fabric.code);
  db.prepare('DELETE FROM fabric_test_reports WHERE fabric_code = ?').run(fabric.code);
  db.prepare('DELETE FROM fabrics WHERE id = ?').run(fabric.id);
  res.json({ ok: true });
});

// ---- Test reports ----

// Every test report ever uploaded, across every fabric - the flat list
// behind the Fabrics section's Reports sub-menu.
router.get('/reports', (req, res) => {
  const rows = db.prepare('SELECT * FROM fabric_test_reports ORDER BY COALESCE(report_date, created_at) DESC, id DESC').all();
  res.json({ reports: rows });
});

// Composition/weight mismatches flagged at upload time (see POST
// /test-reports) - feeds the Notification Centre's "Fabric data
// inconsistencies" section.
router.get('/report-flags', (req, res) => {
  const rows = db.prepare('SELECT * FROM fabric_report_flags ORDER BY created_at DESC, id DESC').all();
  res.json({ flags: rows });
});

// Step 1 of 2: upload a lab report PDF, save it, and run AI extraction on
// its text - returns the extracted fields (plus where the PDF landed) for
// the user to review/correct before anything is written to fabrics or
// fabric_test_reports. Nothing is saved to the database by this route.
router.post('/test-reports/extract', blockBuyerWrite, uploadPdf.single('report'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'A PDF file is required' });
  try {
    const extracted = await extractFabricTestReport(req.file.buffer, openaiClient);
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `fabric-test-${Date.now()}-${rand}.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);
    res.json({ filePath: '/uploads/' + filename, extracted });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not process that PDF' });
  }
});

// Step 2 of 2: persists the (possibly hand-corrected) extracted fields.
// Creates the fabric if this code is new, or updates every field to match
// this latest report if it already exists - fabric_test_reports keeps every
// report ever uploaded, fabrics itself always reflects just the most recent
// one (matching how the 12-month approval-expiry check already reads it).
// Case-insensitive, whitespace-trimmed comparison for the duplicate/
// inconsistency checks below - lab reports vary casing/spacing on the
// exact same fabric ("95.3% Cotton" vs "95.3% COTTON") without that being
// a meaningful difference worth flagging.
function normalizedText(v) {
  return (v || '').toString().trim().toLowerCase();
}

router.post('/test-reports', blockBuyerWrite, (req, res) => {
  const {
    fabric_code, file_path, report_number, style_no, end_buyer,
    sample_description, report_date, weight_gsm, weight_oz, composition, overall_result, report_type
  } = req.body || {};
  if (!fabric_code || !fabric_code.trim()) return res.status(400).json({ error: 'Fabric code is required' });
  if (!file_path) return res.status(400).json({ error: 'Missing uploaded file reference - please upload the PDF again' });
  const code = fabric_code.trim();
  const reportType = report_type === 'print' ? 'print' : 'base';

  // Skip creating an exact re-upload of a report already on file - matched
  // on every field that together identifies "the same lab result", not
  // just the report number (which can be typo'd or blank in scans).
  const duplicate = db.prepare(`
    SELECT id FROM fabric_test_reports
    WHERE fabric_code = ?
      AND TRIM(LOWER(COALESCE(composition,''))) = ?
      AND TRIM(COALESCE(weight_gsm,'')) = ?
      AND TRIM(LOWER(COALESCE(style_no,''))) = ?
      AND report_type = ?
  `).get(code, normalizedText(composition), (weight_gsm||'').trim(), normalizedText(style_no), reportType);
  if (duplicate) {
    return res.status(409).json({ error: 'A report with this fabric code, composition, weight, style number and type already exists', duplicateReportId: duplicate.id });
  }

  // Flag (but don't block) a fabric code being re-tested with a different
  // composition or weight than what's already on file - could be a real
  // fabric change, or a mix-up, either way worth a human glancing at it.
  // Captured before the fabrics-table cascade below overwrites these
  // values, since this is a one-time comparison, not a re-derivable state.
  const existingBefore = db.prepare('SELECT * FROM fabrics WHERE code = ?').get(code);
  let inconsistencyMessage = null;
  if (existingBefore) {
    const compDiffers = existingBefore.composition && composition && normalizedText(existingBefore.composition) !== normalizedText(composition);
    const weightDiffers = existingBefore.weight && weight_oz && (existingBefore.weight||'').trim() !== (weight_oz||'').trim();
    if (compDiffers || weightDiffers) {
      const parts = [];
      if (compDiffers) parts.push(`composition was "${existingBefore.composition}", new report says "${composition}"`);
      if (weightDiffers) parts.push(`weight was "${existingBefore.weight} oz", new report says "${weight_oz} oz"`);
      inconsistencyMessage = `Fabric ${code}: ${parts.join('; ')}.`;
    }
  }

  const info = db.prepare(`
    INSERT INTO fabric_test_reports
      (fabric_code, file_path, report_number, style_no, end_buyer, sample_description,
       report_date, weight_gsm, weight_oz, composition, overall_result, report_type)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, file_path, report_number || null, style_no || null, end_buyer || null, sample_description || null,
         report_date || null, weight_gsm || null, weight_oz || null, composition || null, overall_result || null, reportType);
  relinkReportStyles(info.lastInsertRowid, style_no);

  if (inconsistencyMessage) {
    db.prepare('INSERT INTO fabric_report_flags (fabric_code, report_id, message) VALUES (?, ?, ?)')
      .run(code, info.lastInsertRowid, inconsistencyMessage);
  }

  // A report upload writes composition/weight onto fabrics too - fabrics
  // always reflects the latest report's composition/weight (oz, the unit
  // used everywhere else in the app). Everything else about the report
  // (dates, style/buyer, validity) lives only on fabric_test_reports.
  const existing = existingBefore;
  if (existing) {
    db.prepare(`
      UPDATE fabrics SET composition = ?, weight = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?
    `).run(composition || existing.composition, weight_oz || existing.weight, code);
  } else {
    db.prepare(`INSERT INTO fabrics (code, composition, weight) VALUES (?,?,?)`)
      .run(code, composition || null, weight_oz || null);
  }

  const fabric = db.prepare('SELECT * FROM fabrics WHERE code = ?').get(code);
  const report = db.prepare('SELECT * FROM fabric_test_reports WHERE id = ?').get(info.lastInsertRowid);
  res.json({ fabric, report, inconsistencyMessage });
});

// Edits an already-saved report (e.g. fixing a typo'd Style No.) - unlike
// POST /test-reports above, this never cascades onto the fabrics table:
// that cascade exists so fabrics always reflects its *latest* report, and
// blindly re-applying it here would let an edit to an old, no-longer-
// current report overwrite the fabric's current composition/weight/etc
// with stale data. It does still re-run style linking, since a Style No.
// correction should always update which styles the report shows under.
router.put('/test-reports/:id', blockBuyerWrite, (req, res) => {
  const report = db.prepare('SELECT * FROM fabric_test_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const {
    fabric_code, report_number, style_no, end_buyer, sample_description,
    report_date, weight_gsm, weight_oz, composition, overall_result, report_type
  } = req.body || {};
  if (!fabric_code || !fabric_code.trim()) return res.status(400).json({ error: 'Fabric code is required' });
  const reportType = report_type === 'print' ? 'print' : 'base';

  db.prepare(`
    UPDATE fabric_test_reports SET
      fabric_code = ?, report_number = ?, style_no = ?, end_buyer = ?, sample_description = ?,
      report_date = ?, weight_gsm = ?, weight_oz = ?, composition = ?, overall_result = ?, report_type = ?
    WHERE id = ?
  `).run(
    fabric_code.trim(), report_number || null, style_no || null, end_buyer || null, sample_description || null,
    report_date || null, weight_gsm || null, weight_oz || null, composition || null, overall_result || null, reportType,
    report.id
  );
  relinkReportStyles(report.id, style_no);

  const updated = db.prepare('SELECT * FROM fabric_test_reports WHERE id = ?').get(report.id);
  res.json({ report: updated });
});

// Deletes a single report - its own PDF and style links, not the fabric it
// belongs to (see DELETE /:id above for removing a whole fabric, which
// takes every one of its reports with it). Doesn't touch fabrics.* - if
// this happened to be the fabric's current/mirrored report, that mirrored
// data is left as-is rather than guessing which older report should
// replace it.
router.delete('/test-reports/:id', blockBuyerWrite, (req, res) => {
  const report = db.prepare('SELECT * FROM fabric_test_reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  fs.unlink(resolveUploadPath(report.file_path), () => {});
  db.prepare('DELETE FROM fabric_report_styles WHERE report_id = ?').run(report.id);
  db.prepare('DELETE FROM fabric_test_reports WHERE id = ?').run(report.id);
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

module.exports = router;
