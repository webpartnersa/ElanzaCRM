const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { scopeStyleForRole } = require('../lib/scope');
const { saveBufferAsWebp, convertBufferToWebpFile, makeThumbnailFile } = require('../lib/imageConvert');
const { extractSpecFitFromPdf, extractSpecFitFromXlsx } = require('../lib/specFitReport');
const { buildAppraisalWorkbook } = require('../lib/specAppraisalExport');
const { REQUEST_TYPES, translateMessage } = require('../lib/conceptCostingTranslate');
const { buildGenericRequestEmailHtml, buildGenericRequestPlainText } = require('../lib/conceptGenericRequestEmailHtml');
const { sendMail, isConfigured: mailIsConfigured, resolveSender, parseRecipients } = require('../lib/mailer');
const { buildWashcareLabelPng } = require('../lib/washcareLabelExport');

const router = express.Router();
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function mimeFromExt(filePath){
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.avif') return 'image/avif';
  return 'image/png';
}

const RETAILER_CODES = { PnP: 'P', Eagle: 'E', PEP: 'PE' };
const DEPT_CODES = {
  Ladies: 'L', Mens: 'M', Babywear: 'B',
  'Younger Boys': 'YB', 'Older Boys': 'OB',
  'Younger Girls': 'YG', 'Older Girls': 'OG'
};

function nextStyleNo(retailer, department) {
  const rCode = RETAILER_CODES[retailer] || retailer.slice(0,1).toUpperCase();
  const dCode = DEPT_CODES[department] || 'ST';
  const prefix = rCode + dCode;
  const rows = db.prepare(`SELECT style_no FROM styles WHERE style_no LIKE ?`).all(prefix + '%');
  let max = 0;
  rows.forEach(r => {
    const n = parseInt(String(r.style_no).replace(prefix, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return prefix + String(max + 1).padStart(3, '0');
}

// First non-CAD photo (by upload order) stands in as the board-card
// thumbnail - excluding 'cad' explicitly rather than relying only on
// insertion order, since a CAD image can in principle be uploaded before
// any real reference photo exists.
function attachCoverPhoto(row) {
  const photo = db.prepare("SELECT path, thumb_path FROM photos WHERE style_id = ? AND (role IS NULL OR role NOT IN ('cad','washcare')) ORDER BY id ASC LIMIT 1").get(row.id);
  row.cover_photo = photo ? (photo.thumb_path || photo.path) : null;
  return row;
}

// Saves the full-size webp (saveBufferAsWebp) plus a 200px-wide thumbnail
// alongside it - same pattern as routes/concepts.js's own helper - so
// newly-uploaded photos are board-ready without a separate backfill step.
async function saveBufferAsWebpWithThumb(buffer, destDir, filenamePrefix) {
  const filename = await saveBufferAsWebp(buffer, destDir, filenamePrefix);
  const thumbFilename = filename.replace(/\.webp$/, '-thumb.webp');
  await makeThumbnailFile(buffer, path.join(destDir, thumbFilename));
  return { filename, thumbFilename };
}

// ---- Photo upload setup ----
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];
const OPENAI_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Generated/uploaded CAD images live in their own subfolder, named after
// the style number (e.g. pl425.webp) - same convention as concepts' CAD_DIR.
const CAD_DIR = path.join(UPLOAD_DIR, 'styles');
fs.mkdirSync(CAD_DIR, { recursive: true });

// Resolves a stored path like '/uploads/styles/pl425.webp' or
// '/uploads/style-8-...jpg' back to a real file on disk - handles both the
// flat uploads/ folder and the uploads/styles/ subfolder correctly, unlike
// a plain UPLOAD_DIR + basename join.
function resolveUploadPath(relPath){
  return path.join(__dirname, '..', relPath);
}

// Kept in memory rather than written to disk as-is - every upload gets
// converted to WebP (see lib/imageConvert.js) before it's ever saved.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file - a single phone camera photo can exceed 5MB
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') {
      return cb(new Error('Not authorized to upload photos'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('Only image files are allowed (jpg, png, webp, gif, avif)'));
    cb(null, true);
  }
});

// Twin of routes/concepts.js's /factory-names - same source (Contacts'
// Factory-position company names), just gated by 'styles' instead of
// 'concepts' permission so a styles-only user can still populate their own
// Factory dropdown. Both drawers read from this one Contacts list, so a
// name picked in either place is guaranteed to match a real saved contact
// rather than drifting into ad hoc spellings - see renderStyleFactorySelect
// in public/js/drawer.js. Has to be registered before '/:id' below - Express
// would otherwise match 'factory-names' as an :id and 404 on it.
router.get('/factory-names', requireAuth, requirePermission('styles'), (req, res) => {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const rows = db.prepare('SELECT name FROM factories ORDER BY name ASC').all();
  res.json({ factories: rows.map(r => r.name) });
});

router.get('/', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  let rows;
  if (user.role !== 'buyer') {
    rows = db.prepare('SELECT * FROM styles ORDER BY updated_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM styles WHERE retailer = ? AND department = ? ORDER BY updated_at DESC')
      .all(user.retailer, user.department);
  }
  rows.forEach(attachCoverPhoto);
  res.json({ styles: rows.map(s => scopeStyleForRole(s, user)) });
});

router.get('/:id', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'buyer' && (style.retailer !== user.retailer || style.department !== user.department)) {
    return res.status(403).json({ error: 'Not authorized for this style' });
  }
  attachCoverPhoto(style);
  const comments = db.prepare('SELECT * FROM comments WHERE style_id = ? ORDER BY created_at ASC').all(style.id);
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
  const fabricReports = getFabricReportsForStyle(style.id);
  res.json({ style: scopeStyleForRole(style, user), comments, photos, fabricReports });
});

// ---- Requests (factory-facing) sent from this style ----
// Twin of routes/concepts.js's factory-contact/requests/send-request trio,
// scoped to a confirmed style instead of a still-in-development concept.
// 'cost' isn't offered here - costing negotiation happens at the Concept
// stage (see REQUEST_TYPES/lib/conceptCostingEmailHtml.js), a style already
// has a confirmed PO price by the time it exists. Every send/history row
// lands in the same concept_requests table concepts use, just with
// style_id/style_no/style_description set instead of concept_id/concept_no/
// concept_description - see db.js's ensureConceptRequestsConceptIdNullable.
const STYLE_REQUEST_TYPES = { sample: REQUEST_TYPES.sample, pp_sample: REQUEST_TYPES.pp_sample, bulk_sample: REQUEST_TYPES.bulk_sample, fabric_test: REQUEST_TYPES.fabric_test };

router.get('/:id/factory-contact', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Style not found' });

  const factoryContacts = db.prepare(`
    SELECT c.*, f.name AS company FROM contacts c
    JOIN factories f ON f.id = c.factory_id
    ORDER BY f.name ASC
  `).all();
  let match = null;
  if (style.factory && style.factory.trim()) {
    const needle = style.factory.trim().toLowerCase();
    match = factoryContacts.find(c => (c.company || '').trim().toLowerCase() === needle)
      || factoryContacts.find(c => {
        const company = (c.company || '').trim().toLowerCase();
        return company && (company.includes(needle) || needle.includes(company));
      })
      || null;
  }
  res.json({ match, factoryContacts });
});

router.get('/:id/requests', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const rows = db.prepare(`
    SELECT id, style_id, style_no, style_description, request_type, message, sent_to, sent_by_name, subject, resend_id, status, received_at, reminder_count, last_reminder_at, created_at
    FROM concept_requests WHERE style_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json({ requests: rows });
});

router.post('/:id/send-request', requireAuth, requirePermission('styles'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  if (!mailIsConfigured()) return res.status(500).json({ error: 'Email sending is not configured on the server' });

  const recipients = parseRecipients(req.body && req.body.to);
  if (!recipients.length) {
    return res.status(400).json({ error: 'A valid recipient email is required' });
  }
  const to = recipients.join(', ');
  const requestType = (req.body && req.body.request_type) || 'sample';
  if (!STYLE_REQUEST_TYPES[requestType]) return res.status(400).json({ error: 'Invalid request type' });
  const message = (req.body && req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'A message is required for this request type' });

  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Style not found' });

  const photoRows = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id)
    .filter(p => p.role !== 'cad' && p.role !== 'washcare');

  try {
    let logoDataUrl = null;
    const logoPath = path.join(__dirname, '..', 'public', 'img', 'main-LOGO-transparent.PNG');
    if (fs.existsSync(logoPath)) {
      logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
    }

    const photos = [];
    for (const p of photoRows) {
      const fullPath = resolveUploadPath(p.path);
      if (!fs.existsSync(fullPath)) continue;
      try {
        const pngBuffer = await sharp(fullPath).png().toBuffer();
        photos.push({ dataUrl: 'data:image/png;base64,' + pngBuffer.toString('base64') });
      } catch (e) { /* a broken/unreadable photo shouldn't fail the whole send */ }
    }

    // buildGenericRequestEmailHtml/PlainText only touch concept_no/
    // description/department (duck-typed) - a plain adapter object with the
    // style's own fields in those slots reuses the exact same builder concepts
    // use, no separate style-flavoured template needed.
    const subjectObj = { concept_no: style.style_no, description: style.description, department: style.department };
    const messageZh = await translateMessage(message, openaiClient);
    const html = buildGenericRequestEmailHtml({ concept: subjectObj, requestType, message, messageZh, logoDataUrl, photos });
    const text = buildGenericRequestPlainText({ concept: subjectObj, requestType, message });
    const subject = `${STYLE_REQUEST_TYPES[requestType].en} - ${style.style_no} - ${style.description || ''}`;

    const { from, replyTo } = resolveSender(user);
    const result = await sendMail({ to: recipients, subject, html, text, from, replyTo });

    db.prepare(`
      INSERT INTO concept_requests (style_id, style_no, style_description, request_type, message, sent_to, sent_by_name, subject, html, resend_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(style.id, style.style_no, style.description || '', requestType, message, to, user.name || '', subject, html, result.id || null);

    res.json({ ok: true });
  } catch (e) {
    console.error('Style request send failed:', e.message);
    res.status(500).json({ error: 'Failed to send: ' + e.message });
  }
});

// ---- Fabric reports linked to this style ----
// One report can serve more than one style (the same fabric is often tested
// once and used across e.g. "PG054/PG061"), so the link lives in the
// fabric_report_styles join table - populated automatically whenever a
// report is saved (see routes/fabrics.js's relinkReportStyles), with these
// two routes as a manual fallback/override.
function getFabricReportsForStyle(styleId) {
  return db.prepare(`
    SELECT ftr.* FROM fabric_test_reports ftr
    JOIN fabric_report_styles frs ON frs.report_id = ftr.id
    WHERE frs.style_id = ?
    ORDER BY COALESCE(ftr.report_date, ftr.created_at) DESC, ftr.id DESC
  `).all(styleId);
}

router.post('/:id/fabric-reports', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Style not found' });
  const reportNumber = (req.body && req.body.report_number || '').trim();
  if (!reportNumber) return res.status(400).json({ error: 'A report number is required' });
  const report = db.prepare('SELECT * FROM fabric_test_reports WHERE report_number = ?').get(reportNumber);
  if (!report) return res.status(404).json({ error: `No fabric report found with number "${reportNumber}"` });
  db.prepare('INSERT OR IGNORE INTO fabric_report_styles (report_id, style_id) VALUES (?, ?)').run(report.id, style.id);
  res.json({ fabricReports: getFabricReportsForStyle(style.id) });
});

router.delete('/:id/fabric-reports/:reportId', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const link = db.prepare('SELECT * FROM fabric_report_styles WHERE report_id = ? AND style_id = ?').get(req.params.reportId, req.params.id);
  if (!link) return res.status(404).json({ error: 'Linked report not found' });
  db.prepare('DELETE FROM fabric_report_styles WHERE report_id = ? AND style_id = ?').run(req.params.reportId, req.params.id);
  res.json({ fabricReports: getFabricReportsForStyle(req.params.id) });
});

router.post('/', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot create styles' });
  const { retailer, department, buyer, description, style_no } = req.body || {};
  if (!retailer || !department) {
    return res.status(400).json({ error: 'Retailer and department are required' });
  }
  const finalStyleNo = (style_no && style_no.trim()) ? style_no.trim().toUpperCase() : nextStyleNo(retailer, department);
  try {
    const info = db.prepare(`
      INSERT INTO styles (style_no, retailer, department, buyer, description, stage)
      VALUES (?,?,?,?,?, 'brief')
    `).run(finalStyleNo, retailer.trim(), department.trim(), (buyer||'').trim(), (description||'').trim());
    const created = db.prepare('SELECT * FROM styles WHERE id = ?').get(info.lastInsertRowid);

    // A style IS an order the moment it exists - whether just converted
    // from a concept on the buyer's verbal go-ahead, or created directly -
    // so it lands in the Shipping Schedule's unassigned pool immediately,
    // not only once its stage later reaches 'po' (PO Confirmed). Most
    // fields are still blank at this point (units/rsp/season/colour get
    // filled in via the follow-up PUT the New Style form makes right after
    // this, same as the rest of the drawer's Details tab) - the order row
    // isn't kept in sync with those afterward except style_no (see the PUT
    // handler below), same as a style confirmed at 'po' always worked.
    db.prepare(`
      INSERT INTO orders (style_id, style_no, description, units, rsp, season, colour, container_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(created.id, created.style_no, created.description, created.units, created.target_rsp, created.season, created.colour);

    attachCoverPhoto(created);
    res.json({ style: scopeStyleForRole(created, user) });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `Style number ${finalStyleNo} already exists` });
    res.status(500).json({ error: 'Could not create style' });
  }
});

router.put('/:id', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot edit style records' });
  const before = db.prepare('SELECT stage FROM styles WHERE id = ?').get(req.params.id);
  // Details-tab fields mirror the Concept drawer's Details tab exactly (see
  // public/js/drawer.js's renderBriefTab) - season/raw_brief/spec_notes/
  // target_cost/the old free-text fabric field are retired (no longer
  // editable, columns left in place) since concepts never had them and the
  // new field set replaces what they were standing in for. target_rsp stays
  // editable server-side even though Details no longer sends it - it's
  // still shown read-only on the Style Pipeline board card.
  const fields = [
    'stage', 'description', 'units', 'target_rsp',
    'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
    'topstitch', 'trims', 'styling', 'packing', 'labels', 'source', 'tags', 'concept_date',
    'shipping_date', 'dc_date', 'factory', 'concept_ref', 'cad_description', 'washcare_details', 'art_no',
    'cost_estimate', 'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price', 'factory_cost_options'
  ];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  // '' from a blank <select> means "not set", not the literal string '' -
  // keeps the FK genuinely NULL rather than breaking lookups (same reasoning
  // as routes/concepts.js's toIntOrNull for spec_category_id/size_range_id).
  if (req.body.size_range_id !== undefined) {
    const n = parseInt(req.body.size_range_id, 10);
    updates.push('size_range_id = ?');
    values.push(req.body.size_range_id === '' || req.body.size_range_id == null || isNaN(n) ? null : n);
  }

  // Style No. can be corrected after creation (e.g. a typo, or the manually
  // typed code needs to change) - normalized the same way as at creation
  // time (trim + uppercase) and checked for the same uniqueness conflict.
  let newStyleNo;
  if (req.body.style_no !== undefined) {
    newStyleNo = (req.body.style_no || '').trim().toUpperCase();
    if (!newStyleNo) return res.status(400).json({ error: 'Style number cannot be empty' });
    updates.push('style_no = ?');
    values.push(newStyleNo);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  try {
    db.prepare(`UPDATE styles SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `Style number ${newStyleNo} already exists` });
    return res.status(500).json({ error: 'Could not update style' });
  }
  const updated = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);

  // A style already on the Shipping Schedule keeps its own copy of
  // style_no (orders.style_no) - keep it in sync so a rename here doesn't
  // leave that order showing a stale number.
  if (newStyleNo !== undefined) {
    db.prepare('UPDATE orders SET style_no = ? WHERE style_id = ?').run(updated.style_no, updated.id);
  }

  // Safety net, not the primary trigger anymore - every style already gets
  // its order row at creation time (see POST '/' above). This only catches
  // the rare style that somehow still doesn't have one (e.g. a database
  // from before that changed, or a create that failed after the style
  // insert) by re-checking on every stage move into 'po'. If the stage
  // later moves off 'po', the order is left as-is in Shipping Schedule
  // rather than being silently removed - safer default, revisit if that's wrong.
  if (updated.stage === 'po' && before && before.stage !== 'po') {
    const already = db.prepare('SELECT id FROM orders WHERE style_id = ?').get(updated.id);
    if (!already) {
      db.prepare(`
        INSERT INTO orders (style_id, style_no, description, units, rsp, season, colour, container_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(updated.id, updated.style_no, updated.description, updated.units, updated.target_rsp, updated.season, updated.colour);
    }
  }

  attachCoverPhoto(updated);
  res.json({ style: scopeStyleForRole(updated, user) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot delete styles' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });

  // A style with a live Shipping Schedule order carries real business data
  // (units, container, invoicing, delay history) - refuse rather than
  // silently cascading that away. Remove it from Shipping Schedule first.
  const liveOrder = db.prepare('SELECT id FROM orders WHERE style_id = ?').get(style.id);
  if (liveOrder) return res.status(400).json({ error: 'This style still has an order in the Shipping Schedule - remove it there first' });

  // Clean up photo files on disk before removing the database rows.
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ?').all(style.id);
  photos.forEach(p => {
    fs.unlink(resolveUploadPath(p.path), () => {});
    if (p.thumb_path) fs.unlink(resolveUploadPath(p.thumb_path), () => {});
  });

  // Measurement sheet fit uploads (see specSheetUpload above) also have
  // files on disk to clean up, same as photos.
  const fits = db.prepare('SELECT file_path FROM style_spec_fits WHERE style_id = ?').all(style.id);
  fits.forEach(f => { if (f.file_path) fs.unlink(resolveUploadPath(f.file_path), () => {}); });

  db.prepare('DELETE FROM photos WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM comments WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM concept_conversions WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM fabric_report_styles WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM style_spec_fit_values WHERE fit_id IN (SELECT id FROM style_spec_fits WHERE style_id = ?)').run(style.id);
  db.prepare('DELETE FROM style_spec_fits WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM style_spec_poms WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM styles WHERE id = ?').run(style.id);
  res.json({ ok: true });
});

// Copies a style's full spec/costing/brief data under a new, caller-chosen
// style number - stage resets to 'brief' since a duplicate hasn't actually
// been through Doc Sent/Costed/.../PO Confirmed yet, and those transitions
// have real side effects (e.g. hitting 'po' raises a Shipping Schedule
// order). Photos are copied too, as independent files on disk rather than
// shared paths - deleting a photo unlinks its file (see DELETE
// /:id/photos/:photoId above), so sharing a path would let a delete on
// either style silently break the other's copy.
const DUPLICATE_FIELDS = [
  'retailer', 'department', 'buyer', 'description', 'units', 'target_rsp',
  'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
  'topstitch', 'trims', 'styling', 'packing', 'labels', 'source', 'tags', 'concept_date',
  'shipping_date', 'dc_date', 'size_range_id', 'factory', 'concept_ref', 'cad_description',
  'cost_estimate', 'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price', 'factory_cost_options'
];
router.post('/:id/duplicate', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot duplicate styles' });
  const source = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });
  const styleNo = ((req.body && req.body.style_no) || '').trim().toUpperCase();
  if (!styleNo) return res.status(400).json({ error: 'A new style number is required' });

  const cols = ['style_no', 'stage', ...DUPLICATE_FIELDS];
  const values = [styleNo, 'brief', ...DUPLICATE_FIELDS.map(f => source[f])];
  let created;
  try {
    const info = db.prepare(`INSERT INTO styles (${cols.join(', ')}) VALUES (${cols.map(()=>'?').join(', ')})`).run(...values);
    created = db.prepare('SELECT * FROM styles WHERE id = ?').get(info.lastInsertRowid);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `Style number ${styleNo} already exists` });
    return res.status(500).json({ error: 'Could not duplicate style' });
  }

  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(source.id);
  const insertPhoto = db.prepare('INSERT INTO photos (style_id, path, role, thumb_path) VALUES (?, ?, ?, ?)');
  photos.forEach(p => {
    try {
      let filename, destDir, urlPrefix;
      if (p.role === 'cad') {
        filename = `${created.style_no.toLowerCase()}.webp`;
        destDir = CAD_DIR;
        urlPrefix = '/uploads/styles/';
      } else {
        const ext = path.extname(p.path) || '.webp';
        filename = `style-${created.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
        destDir = UPLOAD_DIR;
        urlPrefix = '/uploads/';
      }
      fs.copyFileSync(resolveUploadPath(p.path), path.join(destDir, filename));
      let thumbUrl = null;
      if (p.thumb_path) {
        try {
          const thumbExt = path.extname(p.thumb_path) || '.webp';
          const thumbFilename = filename.replace(path.extname(filename), '') + '-thumb' + thumbExt;
          fs.copyFileSync(resolveUploadPath(p.thumb_path), path.join(destDir, thumbFilename));
          thumbUrl = urlPrefix + thumbFilename;
        } catch (e) { /* missing thumb shouldn't block copying the full photo */ }
      }
      insertPhoto.run(created.id, urlPrefix + filename, p.role, thumbUrl);
    } catch (e) { /* a missing/unreadable source file shouldn't fail the whole duplicate */ }
  });

  attachCoverPhoto(created);
  res.json({ style: scopeStyleForRole(created, user) });
});

// ---- Photos: multiple per style ----
router.post('/:id/photos', requireAuth, upload.array('photos', 10), async (req, res) => {
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No images received' });
  try {
    const insert = db.prepare('INSERT INTO photos (style_id, path, thumb_path) VALUES (?,?,?)');
    for (const f of req.files) {
      const { filename, thumbFilename } = await saveBufferAsWebpWithThumb(f.buffer, UPLOAD_DIR, `style-${style.id}`);
      insert.run(style.id, '/uploads/' + filename, '/uploads/' + thumbFilename);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Could not process one or more images: ' + e.message });
  }
  db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
  res.json({ photos });
});

router.delete('/:id/photos/:photoId', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const photo = db.prepare('SELECT * FROM photos WHERE id = ? AND style_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  fs.unlink(resolveUploadPath(photo.path), () => {});
  if (photo.thumb_path) fs.unlink(resolveUploadPath(photo.thumb_path), () => {});
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(req.params.id);
  res.json({ photos });
});

router.post('/:id/comments', requireAuth, (req, res) => {
  const user = req.session.user;
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'buyer' && (style.retailer !== user.retailer || style.department !== user.department)) {
    return res.status(403).json({ error: 'Not authorized for this style' });
  }
  const body = (req.body && req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });
  db.prepare('INSERT INTO comments (style_id, author_name, author_role, body) VALUES (?,?,?,?)')
    .run(style.id, user.name, user.role, body);
  const comments = db.prepare('SELECT * FROM comments WHERE style_id = ? ORDER BY created_at ASC').all(style.id);
  res.json({ comments });
});

// Lets someone manually upload/override the main CAD image directly,
// bypassing AI generation entirely - same escape hatch as concepts.js.
router.post('/:id/cad-main', requireAuth, upload.single('photo'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });

  const filename = `${style.style_no.toLowerCase()}.webp`;
  try {
    await convertBufferToWebpFile(req.file.buffer, path.join(CAD_DIR, filename));
  } catch (e) {
    return res.status(400).json({ error: 'Could not process that image: ' + e.message });
  }
  // Replace any previous CAD entry rather than stacking duplicates that
  // would all point at the same (now overwritten) file.
  db.prepare("DELETE FROM photos WHERE style_id = ? AND role = 'cad'").run(style.id);
  db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'cad')").run(style.id, '/uploads/styles/' + filename);
  db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
  res.json({ photos });
});

// Wash Care tab's label image - same single-photo-by-role convention as
// cad-main above (role='washcare' instead of 'cad'), just a plain manual
// upload with no AI-generation escape hatch to worry about. '-washcare'
// suffix on the filename so it never collides with the CAD image, which
// would otherwise land on the exact same `<style_no>.webp` path in this
// same folder.
router.post('/:id/washcare-photo', requireAuth, upload.single('photo'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });

  const filename = `${style.style_no.toLowerCase()}-washcare.webp`;
  try {
    await convertBufferToWebpFile(req.file.buffer, path.join(CAD_DIR, filename));
  } catch (e) {
    return res.status(400).json({ error: 'Could not process that image: ' + e.message });
  }
  db.prepare("DELETE FROM photos WHERE style_id = ? AND role = 'washcare'").run(style.id);
  db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'washcare')").run(style.id, '/uploads/styles/' + filename);
  db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
  const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
  res.json({ photos });
});

// Auto-generates the wash care label from data already on the style/fabric/
// factory (see lib/washcareLabelExport.js) and saves it exactly like a
// manual upload would - same role='washcare' photo row, same
// <style_no>-washcare.webp path - so everything downstream (this drawer,
// Final Submission's washcare_label slot) treats a generated label no
// differently from one someone uploaded by hand.
router.post('/:id/generate-washcare-label', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });

  const fabric = style.fabric_code ? db.prepare('SELECT * FROM fabrics WHERE code = ?').get(style.fabric_code) : null;
  const factory = style.factory ? db.prepare('SELECT * FROM factories WHERE name = ?').get(style.factory) : null;

  try {
    const pngBuffer = await buildWashcareLabelPng({ style, fabric, factory });
    const filename = `${style.style_no.toLowerCase()}-washcare.webp`;
    await convertBufferToWebpFile(pngBuffer, path.join(CAD_DIR, filename));

    db.prepare("DELETE FROM photos WHERE style_id = ? AND role = 'washcare'").run(style.id);
    db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'washcare')").run(style.id, '/uploads/styles/' + filename);
    db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
    const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
    res.json({ photos });
  } catch (e) {
    console.error('Washcare label generation failed:', e.message);
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Sends selected reference photos to OpenAI's image model and saves the
// result back as a photo tagged 'cad' - same prompt/model as concepts.js.
router.post('/:id/generate-cad-ai', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  if (!openaiClient) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server (.env)' });

  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });

  const { photoIds } = req.body || {};
  if (!Array.isArray(photoIds) || !photoIds.length) return res.status(400).json({ error: 'photoIds array is required' });

  const photoRows = photoIds
    .map(id => db.prepare('SELECT * FROM photos WHERE id = ? AND style_id = ?').get(id, style.id))
    .filter(Boolean)
    .filter(p => OPENAI_IMAGE_EXT.includes(path.extname(p.path).toLowerCase()));

  if (!photoRows.length) return res.status(400).json({ error: 'No usable reference photos (must be jpg, png or webp - gif and avif are not supported as AI input)' });

  try {
    const imageFiles = await Promise.all(photoRows.map(p => {
      const fullPath = resolveUploadPath(p.path);
      return toFile(fs.createReadStream(fullPath), null, { type: mimeFromExt(fullPath) });
    }));

    const prompt = `Using the attached reference images, create a high-end photograph of the front and back of the garment${style.description ? ' ("' + style.description + '")' : ''}, as if it were laid flat on a plain white floor/surface and photographed from directly above with soft, even natural lighting - a real photo of a physical garment on a plain white background, not a flat vector illustration or CAD-style graphic. Show realistic fabric texture, weight and drape, with natural folds and soft shadows consistent with real fabric resting on a flat surface.

Look at all the details in the reference images carefully, and do not alter any of the design elements - colour, print, embroidery, construction, and proportions must all match exactly as shown.`;

    const result = await openaiClient.images.edit({
      model: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5',
      image: imageFiles,
      input_fidelity: 'high',
      quality: 'high',
      prompt,
      size: '1536x1024'
    });

    const b64 = result.data[0].b64_json;
    const buffer = Buffer.from(b64, 'base64');
    const filename = `${style.style_no.toLowerCase()}.webp`;
    await convertBufferToWebpFile(buffer, path.join(CAD_DIR, filename));
    db.prepare("DELETE FROM photos WHERE style_id = ? AND role = 'cad'").run(style.id);
    db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'cad')").run(style.id, '/uploads/styles/' + filename);
    db.prepare('UPDATE styles SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(style.id);
    const photos = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id);
    res.json({ photos });
  } catch (e) {
    console.error('Style CAD AI generation failed:', e.message);
    res.status(500).json({ error: 'AI generation failed: ' + (e.message || 'unknown error') });
  }
});

// Wraps a composited CAD sheet (built client-side on canvas) into a real
// PDF and streams it back for download - same as concepts.js.
router.post('/:id/export-cad-pdf', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  const { image } = req.body || {};
  const match = image && image.match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: 'A PNG or JPEG image is required' });

  try {
    const buffer = Buffer.from(match[2], 'base64');
    const pdfDoc = await PDFDocument.create();
    const embedded = match[1] === 'jpeg' ? await pdfDoc.embedJpg(buffer) : await pdfDoc.embedPng(buffer);
    const page = pdfDoc.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
    const pdfBytes = await pdfDoc.save();

    const filename = `${style.style_no.toLowerCase()}.pdf`;
    fs.writeFileSync(path.join(CAD_DIR, filename), pdfBytes);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('Style PDF export failed:', e.message);
    res.status(500).json({ error: 'PDF export failed: ' + e.message });
  }
});

// ---- Measurement spec: a style's copy of its spec category's POM bank
// (style_spec_poms), plus one fixed fit stage per row of actual measurements
// (style_spec_fits/style_spec_fit_values). See db.js for why the bank is
// copied rather than referenced live. ----

const SPEC_FIT_STAGES = ['1st_fit', '2nd_fit', 'seal_pps'];

function normalizeSpecName(v) {
  return (v || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

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

router.get('/:id/spec', requireAuth, requirePermission('styles'), (req, res) => {
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  const { poms, fits } = getStyleSpec(style.id);
  res.json({ spec_category_id: style.spec_category_id, poms, fits });
});

// Rebuilds the style's measurement sheet as a downloadable .xlsx laid out
// like the buyer's own appraisal-report template (see lib/specAppraisalExport.js),
// filled in with whatever fit rounds have actually been recorded.
router.get('/:id/spec/export-appraisal', requireAuth, requirePermission('styles'), async (req, res) => {
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (!style.spec_category_id) return res.status(400).json({ error: 'This style has no measurement sheet yet' });
  const category = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(style.spec_category_id);
  const { poms, fits } = getStyleSpec(style.id);

  try {
    const workbook = await buildAppraisalWorkbook({ style, category, poms, fits });
    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `${style.style_no}-appraisal-report.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('Appraisal report export failed:', e.message);
    res.status(500).json({ error: 'Export failed: ' + e.message });
  }
});

// Picking (or changing) a style's spec category copies that category's
// current POM bank onto the style - a fresh pick just seeds an empty sheet,
// but re-picking after one already exists wipes any recorded fit values
// too, since they were measured against the old POM list. The frontend
// confirms with the user before calling this when a change (not a first
// pick) is happening.
router.post('/:id/spec/select-category', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });

  const catId = req.body && req.body.spec_category_id ? parseInt(req.body.spec_category_id, 10) : null;
  if (!catId) return res.status(400).json({ error: 'A spec category is required' });
  const category = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(catId);
  if (!category) return res.status(404).json({ error: 'Spec category not found' });
  const bankPoms = db.prepare('SELECT * FROM spec_category_poms WHERE spec_category_id = ? ORDER BY sort_order ASC, id ASC').all(catId);
  if (!bankPoms.length) return res.status(400).json({ error: `"${category.name}" has no measurements set up yet in the spec bank - add them from Manage Spec Hierarchy first` });

  const oldFitIds = db.prepare('SELECT id, file_path FROM style_spec_fits WHERE style_id = ?').all(style.id);
  oldFitIds.forEach(f => {
    db.prepare('DELETE FROM style_spec_fit_values WHERE fit_id = ?').run(f.id);
    if (f.file_path) fs.unlink(resolveUploadPath(f.file_path), () => {});
  });
  db.prepare('DELETE FROM style_spec_fits WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM style_spec_poms WHERE style_id = ?').run(style.id);

  const insertPom = db.prepare('INSERT INTO style_spec_poms (style_id, name, spec_to_be, sort_order) VALUES (?,?,?,?)');
  bankPoms.forEach(p => insertPom.run(style.id, p.name, p.spec_to_be, p.sort_order));

  db.prepare('UPDATE styles SET spec_category_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(catId, style.id);

  const { poms, fits } = getStyleSpec(style.id);
  res.json({ spec_category_id: catId, poms, fits });
});

// Manual entry, and also how an upload's reviewed/corrected values get
// confirmed and saved (source/file_path passed through from the extract
// step below) - re-saving an already-recorded stage replaces its values
// rather than adding a second row (UNIQUE(style_id, stage)).
router.put('/:id/spec/fits/:stage', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  const stage = req.params.stage;
  if (!SPEC_FIT_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown fit stage' });
  if (!style.spec_category_id) return res.status(400).json({ error: 'Pick a spec category for this style first' });

  const { fit_date, notes, values, source, file_path } = req.body || {};
  const stylePoms = db.prepare('SELECT id, spec_to_be FROM style_spec_poms WHERE style_id = ?').all(style.id);

  let fit = db.prepare('SELECT * FROM style_spec_fits WHERE style_id = ? AND stage = ?').get(style.id, stage);
  if (fit) {
    db.prepare(`UPDATE style_spec_fits SET fit_date = ?, notes = ?, source = ?, file_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(fit_date || null, notes || null, source === 'upload' ? 'upload' : 'manual', file_path || null, fit.id);
  } else {
    const info = db.prepare(`INSERT INTO style_spec_fits (style_id, stage, fit_date, notes, source, file_path) VALUES (?,?,?,?,?,?)`)
      .run(style.id, stage, fit_date || null, notes || null, source === 'upload' ? 'upload' : 'manual', file_path || null);
    fit = { id: info.lastInsertRowid };
  }

  // Most fit rounds only change a handful of points of measure - anything
  // not given here (blank input, or a POM the uploaded sheet didn't match)
  // falls back to the style's own spec-to-be value, rather than being left
  // unrecorded, since that's what "on spec, nothing to flag" means in
  // practice. Only a POM with no spec-to-be at all (bank never got one) is
  // genuinely left unrecorded.
  db.prepare('DELETE FROM style_spec_fit_values WHERE fit_id = ?').run(fit.id);
  const insertVal = db.prepare('INSERT INTO style_spec_fit_values (fit_id, pom_id, actual_value) VALUES (?,?,?)');
  stylePoms.forEach(p => {
    const given = values && values[p.id] != null ? String(values[p.id]).trim() : '';
    const val = given !== '' ? given : (p.spec_to_be || '').toString().trim();
    if (val !== '') insertVal.run(fit.id, p.id, val);
  });

  const { poms, fits } = getStyleSpec(style.id);
  res.json({ poms, fits });
});

router.delete('/:id/spec/fits/:stage', requireAuth, requirePermission('styles'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const stage = req.params.stage;
  if (!SPEC_FIT_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown fit stage' });
  const fit = db.prepare('SELECT * FROM style_spec_fits WHERE style_id = ? AND stage = ?').get(req.params.id, stage);
  if (fit) {
    db.prepare('DELETE FROM style_spec_fit_values WHERE fit_id = ?').run(fit.id);
    db.prepare('DELETE FROM style_spec_fits WHERE id = ?').run(fit.id);
    if (fit.file_path) fs.unlink(resolveUploadPath(fit.file_path), () => {});
  }
  const { poms, fits } = getStyleSpec(req.params.id);
  res.json({ poms, fits });
});

// Step 1 of 2 for the upload path: read the file, extract actual values
// against this style's own POM names, save the file so it's referenceable
// either way, and return the matches for review - nothing is written to
// style_spec_fits/values until the reviewed result is PUT to
// /:id/spec/fits/:stage above, same two-step shape as fabric report uploads.
const specSheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') return cb(new Error('Not authorized to upload fit sheets'));
    const okTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    if (!okTypes.includes(file.mimetype)) return cb(new Error('Only PDF or .xlsx files are allowed'));
    cb(null, true);
  }
});

router.post('/:id/spec/fits/:stage/extract', requireAuth, requirePermission('styles'), specSheetUpload.single('sheet'), async (req, res) => {
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  const stage = req.params.stage;
  if (!SPEC_FIT_STAGES.includes(stage)) return res.status(400).json({ error: 'Unknown fit stage' });
  if (!req.file) return res.status(400).json({ error: 'A PDF or .xlsx file is required' });
  const poms = db.prepare('SELECT * FROM style_spec_poms WHERE style_id = ?').all(style.id);
  if (!poms.length) return res.status(400).json({ error: 'This style has no measurement sheet yet - pick a spec category first' });
  const pomNames = poms.map(p => p.name);

  try {
    const isXlsx = req.file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const extracted = isXlsx
      ? await extractSpecFitFromXlsx(req.file.buffer, openaiClient, pomNames)
      : await extractSpecFitFromPdf(req.file.buffer, openaiClient, pomNames);

    const filename = `spec-fit-${style.id}-${stage}-${Date.now()}${isXlsx ? '.xlsx' : '.pdf'}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), req.file.buffer);

    const byNormName = {};
    poms.forEach(p => { byNormName[normalizeSpecName(p.name)] = p; });
    const matched = {};
    const unmatched = [];
    Object.entries(extracted.values).forEach(([name, value]) => {
      const pom = byNormName[normalizeSpecName(name)];
      if (pom) matched[pom.id] = value;
      else unmatched.push({ name, value });
    });

    res.json({ file_path: '/uploads/' + filename, fit_date: extracted.fit_date, matched, unmatched });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not process that file' });
  }
});

// Catches errors thrown by multer (bad file type, too large, role rejection)
// and returns clean JSON instead of Express's default HTML error page.
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

module.exports = router;
