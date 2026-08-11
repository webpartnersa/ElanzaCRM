const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { DOC_TYPES } = require('../lib/finalSubmissionDocTypes');
const { buildAppraisalWorkbook } = require('../lib/specAppraisalExport');
const { buildMaterialSubmissionWorkbook } = require('../lib/materialSubmissionExport');
const { buildChecklistWorkbook } = require('../lib/submissionChecklistExport');
const { buildWashcareLabelPng } = require('../lib/washcareLabelExport');
const { convertBufferToWebpFile } = require('../lib/imageConvert');
const { sendMail, isConfigured: mailIsConfigured, resolveSender } = require('../lib/mailer');

const router = express.Router();

// Section-level gate: same section as the rest of the Shipping Schedule
// (this lives inside an order's own drawer), independent of role - see
// db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('shipping'));

function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

// Deliberately NOT under public/ or the /uploads static mount (see
// server.js) - every file here is only ever reached through the
// authenticated routes below, never by a guessable URL. One folder per
// style/order so a factory-facing zip is just "everything in this folder".
const PRIVATE_DIR = path.join(__dirname, '..', 'private', 'final-submission');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

function safeSegment(v, fallback) {
  const s = (v || fallback || '').toString().trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return s || fallback;
}
function orderDir(order) {
  const dir = path.join(PRIVATE_DIR, safeSegment(order.style_no, 'style'), safeSegment(order.order_no, 'order' + order.id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Fabric test reports live in the ordinary (public) uploads dir - this slot
// just links to whichever one is already attached to the order's style
// (see fabric_report_styles), same file the Fabrics section itself serves.
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
function resolveUploadPath(relPath) {
  return path.join(__dirname, '..', relPath.replace(/^\/+/, ''));
}
// Same folder routes/styles.js's CAD_DIR points at - the wash care label is
// saved there (as <style_no>-washcare.webp) so it's the exact same file a
// manual upload on the Style drawer would produce, not a separate copy.
const STYLE_UPLOAD_DIR = path.join(UPLOAD_DIR, 'styles');

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
}
function getStyleForOrder(order) {
  return order.style_id ? db.prepare('SELECT * FROM styles WHERE id = ?').get(order.style_id) : null;
}
function getFactoryForStyle(style) {
  if (!style || !style.factory) return null;
  return db.prepare('SELECT * FROM factories WHERE name = ?').get(style.factory);
}
function getFabricForOrder(order) {
  if (!order.fabric_code) return null;
  return db.prepare('SELECT * FROM fabrics WHERE code = ?').get(order.fabric_code);
}
// Same query as routes/styles.js's getStyleSpec (kept local rather than
// shared - see this codebase's existing per-file mimeFromExt duplication
// for the same reasoning: route files don't require each other here).
const SPEC_FIT_STAGES = ['1st_fit', '2nd_fit', 'seal_pps'];
function getStyleSpec(styleId) {
  const poms = db.prepare('SELECT * FROM style_spec_poms WHERE style_id = ? ORDER BY sort_order ASC, id ASC').all(styleId);
  const fitRows = db.prepare('SELECT * FROM style_spec_fits WHERE style_id = ?').all(styleId);
  const fits = {};
  SPEC_FIT_STAGES.forEach(stage => { fits[stage] = null; });
  fitRows.forEach(f => {
    const values = db.prepare('SELECT pom_id, actual_value FROM style_spec_fit_values WHERE fit_id = ?').all(f.id);
    const valueMap = {};
    values.forEach(v => { valueMap[v.pom_id] = v.actual_value; });
    fits[f.stage] = { id: f.id, fit_date: f.fit_date, notes: f.notes, source: f.source, file_path: f.file_path, values: valueMap };
  });
  return { poms, fits };
}
function findLinkedFabricReport(styleId) {
  if (!styleId) return null;
  return db.prepare(`
    SELECT r.* FROM fabric_test_reports r
    JOIN fabric_report_styles frs ON frs.report_id = r.id
    WHERE frs.style_id = ?
    ORDER BY r.report_date DESC, r.id DESC
    LIMIT 1
  `).get(styleId);
}
// The wash care label is a style-level photo (role='washcare' - see
// routes/styles.js's washcare-photo/generate-washcare-label routes), not an
// order-level upload - same "auto-detect from where it already lives"
// pattern as findLinkedFabricReport above, just a different source table.
function findWashcarePhoto(styleId) {
  if (!styleId) return null;
  return db.prepare("SELECT * FROM photos WHERE style_id = ? AND role = 'washcare' ORDER BY id DESC LIMIT 1").get(styleId);
}

// Resolves a filled 'linked' slot to a real file on disk - there are two
// kinds now (fabric_test_report, washcare_label), each backed by a
// different table, so this branches on the slot key rather than assuming
// linked always means the fabric report. Shared by the zip and email
// attachment builders below so they don't each hardcode both cases.
function resolveLinkedFile(slotKey, styleId) {
  if (slotKey === 'fabric_test_report') {
    const linked = findLinkedFabricReport(styleId);
    if (!linked) return null;
    return { fullPath: resolveUploadPath(linked.file_path), filename: `${linked.fabric_code || 'fabric'}-test-report.pdf` };
  }
  if (slotKey === 'washcare_label') {
    const photo = findWashcarePhoto(styleId);
    if (!photo) return null;
    return { fullPath: resolveUploadPath(photo.path), filename: path.basename(photo.path) };
  }
  return null;
}

// Builds the full slot list for an order: each of the 8 fixed doc types,
// merged with whatever's actually on file - an explicit
// order_submission_docs row if one exists, or (fabric_test_report only) an
// auto-detected link to the style's most recent fabric test report.
function getSlots(order) {
  const style = getStyleForOrder(order);
  const rows = db.prepare('SELECT * FROM order_submission_docs WHERE order_id = ?').all(order.id);
  const byType = {};
  rows.forEach(r => { byType[r.doc_type] = r; });

  return DOC_TYPES.map(dt => {
    const row = byType[dt.key];
    if (row) {
      return {
        ...dt,
        filled: true,
        source_actual: row.source,
        original_filename: row.original_filename,
        uploaded_by: row.uploaded_by,
        created_at: row.created_at,
      };
    }
    if (dt.key === 'fabric_test_report') {
      const linked = findLinkedFabricReport(style && style.id);
      if (linked) {
        return {
          ...dt,
          filled: true,
          source_actual: 'linked',
          original_filename: `${linked.fabric_code || 'fabric'}-test-report.pdf`,
          uploaded_by: null,
          created_at: linked.created_at,
          linked_report_id: linked.id,
        };
      }
    }
    if (dt.key === 'washcare_label') {
      const photo = findWashcarePhoto(style && style.id);
      if (photo) {
        return {
          ...dt,
          filled: true,
          source_actual: 'linked',
          original_filename: path.basename(photo.path),
          uploaded_by: null,
          created_at: photo.created_at,
        };
      }
    }
    return { ...dt, filled: false };
  });
}

function bumpStatusIfNone(orderId) {
  const o = db.prepare('SELECT final_submission_status FROM orders WHERE id = ?').get(orderId);
  if (o && !o.final_submission_status) {
    db.prepare(`UPDATE orders SET final_submission_status = 'in_progress' WHERE id = ?`).run(orderId);
  }
}

router.get('/orders/:id/submission', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ status: order.final_submission_status || '', slots: getSlots(order) });
});

// Generates a doc server-side from data already in the CRM - only the two
// slots whose source is 'generate' (see lib/finalSubmissionDocTypes.js)
// support this; everything else has to be uploaded.
router.post('/orders/:id/submission/:docType/generate', blockBuyerWrite, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const dt = DOC_TYPES.find(d => d.key === req.params.docType);
  if (!dt || dt.source !== 'generate') return res.status(400).json({ error: 'This document cannot be auto-generated - upload it instead' });

  const style = getStyleForOrder(order);

  // Wash care label doesn't fit the xlsx-build-and-store-under-the-order
  // shape below - it's a PNG saved as the style's own role='washcare' photo
  // (see routes/styles.js's generate-washcare-label, which this mirrors),
  // detected via findWashcarePhoto rather than an order_submission_docs row.
  if (dt.key === 'washcare_label') {
    if (!style) return res.status(400).json({ error: 'This order has no linked style' });
    try {
      const fabric = getFabricForOrder(order);
      const factory = getFactoryForStyle(style);
      const pngBuffer = await buildWashcareLabelPng({ style, fabric, factory });
      const filename = `${style.style_no.toLowerCase()}-washcare.webp`;
      await convertBufferToWebpFile(pngBuffer, path.join(STYLE_UPLOAD_DIR, filename));
      db.prepare("DELETE FROM photos WHERE style_id = ? AND role = 'washcare'").run(style.id);
      db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'washcare')").run(style.id, '/uploads/styles/' + filename);
      db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
      bumpStatusIfNone(order.id);
      return res.json({ slots: getSlots(order) });
    } catch (e) {
      console.error('Washcare label generation failed:', e.message);
      return res.status(500).json({ error: 'Generation failed: ' + e.message });
    }
  }

  try {
    let workbook, filename;
    if (dt.key === 'sample_appraisal_report') {
      if (!style) return res.status(400).json({ error: 'This order has no linked style' });
      if (!style.spec_category_id) return res.status(400).json({ error: 'This style has no measurement sheet yet - set one up on the Style first' });
      const category = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(style.spec_category_id);
      const { poms, fits } = getStyleSpec(style.id);
      workbook = await buildAppraisalWorkbook({ style, category, poms, fits });
      filename = `${order.style_no || style.style_no}-sample-appraisal-report.xlsx`;
    } else if (dt.key === 'data_sheet') {
      const fabric = getFabricForOrder(order);
      const factory = getFactoryForStyle(style);
      workbook = await buildMaterialSubmissionWorkbook({ order, style, fabric, factory });
      filename = `${order.style_no || 'style'}-material-submission.xlsx`;
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const dir = orderDir(order);
    const storedName = `${dt.key}.xlsx`;
    fs.writeFileSync(path.join(dir, storedName), buffer);
    const relPath = path.join(safeSegment(order.style_no, 'style'), safeSegment(order.order_no, 'order' + order.id), storedName);

    db.prepare(`
      INSERT INTO order_submission_docs (order_id, doc_type, source, file_path, original_filename, uploaded_by)
      VALUES (?, ?, 'generated', ?, ?, ?)
      ON CONFLICT(order_id, doc_type) DO UPDATE SET
        source = 'generated', file_path = excluded.file_path,
        original_filename = excluded.original_filename, uploaded_by = excluded.uploaded_by,
        created_at = CURRENT_TIMESTAMP
    `).run(order.id, dt.key, relPath, filename, req.session.user.name);
    bumpStatusIfNone(order.id);

    res.json({ slots: getSlots(order) });
  } catch (e) {
    console.error('Submission doc generation failed:', e.message);
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

const ALLOWED_EXT = ['.pdf', '.xlsx', '.xls', '.png', '.jpg', '.jpeg'];
const uploadDoc = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') return cb(new Error('Not authorized'));
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('Unsupported file type - allowed: PDF, Excel, PNG, JPG'));
    cb(null, true);
  }
});

router.post('/orders/:id/submission/:docType/upload', blockBuyerWrite, uploadDoc.single('file'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const dt = DOC_TYPES.find(d => d.key === req.params.docType);
  if (!dt) return res.status(400).json({ error: 'Unknown document type' });
  if (!req.file) return res.status(400).json({ error: 'A file is required' });

  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const dir = orderDir(order);
  const storedName = `${dt.key}${ext}`;
  fs.writeFileSync(path.join(dir, storedName), req.file.buffer);
  const relPath = path.join(safeSegment(order.style_no, 'style'), safeSegment(order.order_no, 'order' + order.id), storedName);

  db.prepare(`
    INSERT INTO order_submission_docs (order_id, doc_type, source, file_path, original_filename, uploaded_by)
    VALUES (?, ?, 'uploaded', ?, ?, ?)
    ON CONFLICT(order_id, doc_type) DO UPDATE SET
      source = 'uploaded', file_path = excluded.file_path,
      original_filename = excluded.original_filename, uploaded_by = excluded.uploaded_by,
      created_at = CURRENT_TIMESTAMP
  `).run(order.id, dt.key, relPath, req.file.originalname, req.session.user.name);
  bumpStatusIfNone(order.id);

  res.json({ slots: getSlots(order) });
});

router.delete('/orders/:id/submission/:docType', blockBuyerWrite, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT * FROM order_submission_docs WHERE order_id = ? AND doc_type = ?').get(order.id, req.params.docType);
  if (row) {
    fs.unlink(path.join(PRIVATE_DIR, row.file_path), () => {});
    db.prepare('DELETE FROM order_submission_docs WHERE id = ?').run(row.id);
  }
  res.json({ slots: getSlots(order) });
});

router.get('/orders/:id/submission/:docType/file', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT * FROM order_submission_docs WHERE order_id = ? AND doc_type = ?').get(order.id, req.params.docType);
  let fullPath, filename;
  if (row) {
    fullPath = path.join(PRIVATE_DIR, row.file_path);
    filename = row.original_filename || path.basename(row.file_path);
  } else if (req.params.docType === 'fabric_test_report') {
    const style = getStyleForOrder(order);
    const linked = findLinkedFabricReport(style && style.id);
    if (!linked) return res.status(404).json({ error: 'No file on this slot' });
    fullPath = resolveUploadPath(linked.file_path);
    filename = `${linked.fabric_code || 'fabric'}-test-report.pdf`;
  } else if (req.params.docType === 'washcare_label') {
    const style = getStyleForOrder(order);
    const photo = findWashcarePhoto(style && style.id);
    if (!photo) return res.status(404).json({ error: 'No file on this slot' });
    fullPath = resolveUploadPath(photo.path);
    filename = path.basename(photo.path);
  } else {
    return res.status(404).json({ error: 'No file on this slot' });
  }
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' });
  res.set('Content-Type', mimeFromExt(fullPath));
  res.set('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
  fs.createReadStream(fullPath).pipe(res);
});

router.patch('/orders/:id/submission/status', blockBuyerWrite, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { status } = req.body || {};
  if (!['', 'in_progress', 'ready', 'sent'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE orders SET final_submission_status = ? WHERE id = ?').run(status, order.id);
  res.json({ status });
});

function zipName(order) {
  return `${order.style_no || 'style'}-${order.order_no || order.id}-final-submission.zip`;
}

// Builds the same zip both the download route and the email route send -
// every filled slot, plus a freshly-built checklist.xlsx cover sheet
// (always regenerated from live status, never stored as its own slot - see
// lib/submissionChecklistExport.js). Resolves to a Buffer rather than
// streaming, since the email route needs the whole thing in memory anyway
// to base64 it for Resend - the download route just sends the buffer
// straight through.
async function buildSubmissionZipBuffer(order, style, slots) {
  const buyerContact = style && style.buyer ? style.buyer : null;
  const checklistWb = buildChecklistWorkbook({
    order, style, attn: buyerContact,
    filled: new Set(slots.filter(s => s.filled).map(s => s.key)),
  });
  const checklistBuffer = await checklistWb.xlsx.writeBuffer();

  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const chunks = [];
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));

    archive.append(Buffer.from(checklistBuffer), { name: '00-checklist.xlsx' });

    slots.filter(s => s.filled).forEach((s, i) => {
      let fullPath;
      if (s.source_actual === 'linked') {
        const linked = resolveLinkedFile(s.key, style && style.id);
        if (!linked) return;
        fullPath = linked.fullPath;
      } else {
        const row = db.prepare('SELECT * FROM order_submission_docs WHERE order_id = ? AND doc_type = ?').get(order.id, s.key);
        if (!row) return;
        fullPath = path.join(PRIVATE_DIR, row.file_path);
      }
      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath);
        archive.file(fullPath, { name: `${String(i + 1).padStart(2, '0')}-${s.key}${ext}` });
      }
    });

    archive.finalize();
  });
}

// Same set of files as buildSubmissionZipBuffer, but as separate Resend
// attachments rather than one zip - each doc arrives in the email as its
// own file (buyers/forwarders can grab just the one they need), plus the
// checklist cover sheet as its own attachment too.
async function buildSubmissionAttachments(order, style, slots) {
  const buyerContact = style && style.buyer ? style.buyer : null;
  const checklistWb = buildChecklistWorkbook({
    order, style, attn: buyerContact,
    filled: new Set(slots.filter(s => s.filled).map(s => s.key)),
  });
  const checklistBuffer = await checklistWb.xlsx.writeBuffer();
  const attachments = [{ filename: `00-checklist-${order.style_no || 'style'}.xlsx`, content: Buffer.from(checklistBuffer).toString('base64') }];

  slots.filter(s => s.filled).forEach(s => {
    let fullPath, filename;
    if (s.source_actual === 'linked') {
      const linked = resolveLinkedFile(s.key, style && style.id);
      if (!linked) return;
      fullPath = linked.fullPath;
      filename = linked.filename;
    } else {
      const row = db.prepare('SELECT * FROM order_submission_docs WHERE order_id = ? AND doc_type = ?').get(order.id, s.key);
      if (!row) return;
      fullPath = path.join(PRIVATE_DIR, row.file_path);
      filename = row.original_filename || path.basename(row.file_path);
    }
    if (fs.existsSync(fullPath)) {
      attachments.push({ filename, content: fs.readFileSync(fullPath).toString('base64') });
    }
  });

  return attachments;
}

router.get('/orders/:id/submission/zip', async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const style = getStyleForOrder(order);
  const slots = getSlots(order);
  try {
    const buffer = await buildSubmissionZipBuffer(order, style, slots);
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipName(order)}"`);
    res.send(buffer);
  } catch (e) {
    console.error('Zip build failed:', e.message);
    res.status(500).json({ error: 'Zip build failed: ' + e.message });
  }
});

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Sends the bundle to the merchandiser's own inbox rather than straight to
// the buyer - see the "Email me this submission" button - so it's a real
// email landing in Sent/Inbox they can review and forward to PnP on their
// own schedule, instead of either firing off to the buyer unreviewed or
// making them manually re-attach a separately-downloaded zip to a fresh
// draft. Each document rides as its own attachment (not zipped) so a
// forward can drop whichever ones don't apply.
router.post('/orders/:id/submission/email', blockBuyerWrite, async (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  if (!mailIsConfigured()) return res.status(400).json({ error: 'Email sending is not configured (RESEND_API_KEY/RESEND_FROM missing from .env)' });

  const style = getStyleForOrder(order);
  const slots = getSlots(order);
  const filledCount = slots.filter(s => s.filled).length;
  const requiredCount = slots.filter(s => !s.optional).length;
  const requiredFilledCount = slots.filter(s => !s.optional && s.filled).length;
  const user = req.session.user;

  try {
    const attachments = await buildSubmissionAttachments(order, style, slots);
    const label = `${order.style_no}${order.order_no ? ' / PO ' + order.order_no : ''}`;
    const subject = `Final Submission Ready - ${label}`;
    const incompleteNote = requiredFilledCount < requiredCount
      ? `<p style="color:#A63A3A;">Heads up: only ${requiredFilledCount} of ${requiredCount} required documents are on file yet - this bundle isn't complete.</p>`
      : '';
    const html = `
      <p>The final submission documents for <strong>${escapeHtml(order.style_no)}</strong>${order.description ? ' - ' + escapeHtml(order.description) : ''}${order.order_no ? ' (PO ' + escapeHtml(order.order_no) + ')' : ''} are attached individually (${filledCount}/${slots.length} documents, plus a checklist cover sheet).</p>
      ${incompleteNote}
      <p>Forward this to PnP whenever you're ready.</p>
    `;
    const text = `Final submission documents for ${label} are attached individually (${filledCount}/${slots.length} documents). ${requiredFilledCount < requiredCount ? `Only ${requiredFilledCount}/${requiredCount} required documents are on file yet. ` : ''}Forward to PnP whenever you're ready.`;

    const { from, replyTo } = resolveSender(user);
    await sendMail({ to: user.email, subject, html, text, from, replyTo, attachments });
    res.json({ ok: true, sentTo: user.email });
  } catch (e) {
    console.error('Submission email failed:', e.message);
    res.status(500).json({ error: 'Failed to send: ' + e.message });
  }
});

module.exports = router;
