const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');
const { PDFDocument } = require('pdf-lib');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { scopeStyleForRole } = require('../lib/scope');
const { saveBufferAsWebp, convertBufferToWebpFile } = require('../lib/imageConvert');

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
  const photo = db.prepare("SELECT path FROM photos WHERE style_id = ? AND (role IS NULL OR role != 'cad') ORDER BY id ASC LIMIT 1").get(row.id);
  row.cover_photo = photo ? photo.path : null;
  return row;
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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') {
      return cb(new Error('Not authorized to upload photos'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('Only image files are allowed (jpg, png, webp, gif, avif)'));
    cb(null, true);
  }
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
  res.json({ style: scopeStyleForRole(style, user), comments, photos });
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
const fields = [
    'stage', 'description', 'season', 'units', 'target_rsp', 'raw_brief',
    'fabric', 'colour', 'wash', 'topstitch', 'trims', 'styling', 'spec_notes', 'shipment_note', 'target_cost',
    'cost', 'margin', 'factory', 'first_ship', 'first_delivery', 'concept_ref', 'cad_description'
  ];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE styles SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);

  // Feeds the Shipping Schedule's unassigned pool: the moment a style is
  // first confirmed on order ('po' = the "PO Confirmed" board stage), drop
  // it into orders with no container yet. Only fires on the transition
  // INTO this stage, not every save while already there, so re-saving an
  // already-confirmed style doesn't create duplicates. If the stage later
  // moves off 'po', the order is left as-is in Shipping Schedule rather
  // than being silently removed - safer default, revisit if that's wrong.
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
  photos.forEach(p => fs.unlink(resolveUploadPath(p.path), () => {}));

  db.prepare('DELETE FROM photos WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM comments WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM concept_conversions WHERE style_id = ?').run(style.id);
  db.prepare('DELETE FROM styles WHERE id = ?').run(style.id);
  res.json({ ok: true });
});

// ---- Photos: multiple per style ----
router.post('/:id/photos', requireAuth, upload.array('photos', 10), async (req, res) => {
  const style = db.prepare('SELECT * FROM styles WHERE id = ?').get(req.params.id);
  if (!style) return res.status(404).json({ error: 'Not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No images received' });
  try {
    const insert = db.prepare('INSERT INTO photos (style_id, path) VALUES (?,?)');
    for (const f of req.files) {
      const filename = await saveBufferAsWebp(f.buffer, UPLOAD_DIR, `style-${style.id}`);
      insert.run(style.id, '/uploads/' + filename);
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

// Catches errors thrown by multer (bad file type, too large, role rejection)
// and returns clean JSON instead of Express's default HTML error page.
router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

module.exports = router;
