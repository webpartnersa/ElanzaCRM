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
const { saveBufferAsWebp, convertBufferToWebpFile, makeThumbnailFile } = require('../lib/imageConvert');
const { translateConceptFields, translateMessage, REQUEST_TYPES, LABELS } = require('../lib/conceptCostingTranslate');
const { buildCostingEmailHtml, buildCostingPlainText } = require('../lib/conceptCostingEmailHtml');
const { buildGenericRequestEmailHtml, buildGenericRequestPlainText } = require('../lib/conceptGenericRequestEmailHtml');
const { sendMail, isConfigured: mailIsConfigured, resolveSender, parseRecipients } = require('../lib/mailer');

const router = express.Router();
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function mimeFromExt(filePath){
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.avif') return 'image/avif';
  return 'image/png';
}

const DEPT_CODES = {
  Ladies: 'L', Mens: 'M', Babywear: 'B',
  'Younger Boys': 'YB', 'Older Boys': 'OB',
  'Younger Girls': 'YG', 'Older Girls': 'OG'
};

function nextConceptNo(department) {
  const code = DEPT_CODES[department] || 'X';
  const prefix = 'C' + code;
  const rows = db.prepare('SELECT concept_no FROM concepts WHERE concept_no LIKE ?').all(prefix + '%');
  let max = 0;
  rows.forEach(r => {
    const n = parseInt(String(r.concept_no).replace(prefix, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return prefix + String(max + 1).padStart(3, '0');
}

// Buyers get full browsing access to the range, but never see cost/factory -
// same principle as scopeStyleForRole in lib/scope.js, kept local here since
// concepts have their own field set.
const BUYER_VISIBLE_CONCEPT_FIELDS = [
  'id', 'concept_no', 'department', 'description', 'source', 'tags',
  'cover_photo', 'has_cad', 'concept_date', 'created_at', 'updated_at',
  'spec_category_id', 'size_range_id'
];

// '' from a form field means "not set" here, not the literal string '' -
// keeps spec_category_id/size_range_id genuinely NULL (a real FK or
// nothing) rather than an empty string that would break lookups.
function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}
function scopeConceptForRole(concept, user) {
  if (user.role !== 'buyer') return concept;
  const scoped = {};
  BUYER_VISIBLE_CONCEPT_FIELDS.forEach(f => { scoped[f] = concept[f]; });
  return scoped;
}

function attachCoverPhoto(row) {
  const photo = db.prepare('SELECT path, thumb_path FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC LIMIT 1').get(row.id);
  row.cover_photo = photo ? (photo.thumb_path || photo.path) : null;
  const cad = db.prepare("SELECT 1 FROM concept_photos WHERE concept_id = ? AND role = 'cad' LIMIT 1").get(row.id);
  row.has_cad = !!cad;
  return row;
}

// Saves the full-size webp (saveBufferAsWebp) plus a 200px-wide thumbnail
// alongside it - shared by both reference-photo upload routes below, so
// newly-uploaded photos are board-ready without a separate backfill step.
async function saveBufferAsWebpWithThumb(buffer, destDir, filenamePrefix) {
  const filename = await saveBufferAsWebp(buffer, destDir, filenamePrefix);
  const thumbFilename = filename.replace(/\.webp$/, '-thumb.webp');
  await makeThumbnailFile(buffer, path.join(destDir, thumbFilename));
  return { filename, thumbFilename };
}

// ---- Photo upload setup (shared uploads/ folder, concept- prefix) ----
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'];

// Generated CAD sheets (both the local composite and the AI version) live
// in their own subfolder, named after the concept number - e.g. cl001.png -
// rather than the usual concept-<id>-<timestamp> pattern used for uploads.
const CAD_DIR = path.join(UPLOAD_DIR, 'concepts');
fs.mkdirSync(CAD_DIR, { recursive: true });

// Resolves a stored path like '/uploads/concepts/cl001.png' or
// '/uploads/concept-8-...jpg' back to a real file on disk - handles both
// the flat uploads/ folder and the uploads/concepts/ subfolder correctly,
// unlike a plain UPLOAD_DIR + basename join.
function resolveUploadPath(relPath){
  return path.join(__dirname, '..', relPath);
}

// Kept in memory rather than written to disk as-is - every upload gets
// converted to WebP (see lib/imageConvert.js) before it's ever saved, so
// there's no raw file on disk to name/place until after that conversion.
// 15MB per file - matches the rest of the app's upload limits (fabric
// reports, fit sheets). 5MB used to be the limit here but a single modern
// phone camera photo routinely exceeds that (mobile's "Take Photo" flow
// in particular), which was rejecting real uploads outright.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!req.session.user || req.session.user.role === 'buyer') {
      return cb(new Error('Not authorized to upload photos'));
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) return cb(new Error('Only image files are allowed (jpg, png, webp, gif, avif)'));
    cb(null, true);
  }
});

// ---- List / search (everyone, including buyers) ----
router.get('/', requireAuth, requirePermission('concepts'), (req, res) => {
  const user = req.session.user;
  // Concepts have no retailer of their own (they're pre-retailer design
  // ideas), just a department - a buyer only sees concepts in their own
  // department, same scoping principle as styles.js's retailer+department filter.
  const rows = user.role === 'buyer'
    ? db.prepare('SELECT * FROM concepts WHERE department = ? ORDER BY created_at DESC').all(user.department)
    : db.prepare('SELECT * FROM concepts ORDER BY created_at DESC').all();
  rows.forEach(attachCoverPhoto);
  res.json({ concepts: rows.map(c => scopeConceptForRole(c, user)) });
});

// Backs the Concept drawer's Factory dropdown (see public/js/concepts.js /
// public/mobile/app.js) - just the company names, not full contact records
// (email/phone), so this can sit under the 'concepts' permission rather
// than requiring the separate 'contacts' one just to pick a factory. Buyers
// never see the Factory field at all (stripped server-side elsewhere), so
// this is blocked for them too rather than leaking factory names. Has to
// be registered before the '/:id' route below - Express would otherwise
// match 'factory-names' as an :id and 404 on it as a nonexistent concept.
router.get('/factory-names', requireAuth, requirePermission('concepts'), (req, res) => {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const rows = db.prepare('SELECT name FROM factories ORDER BY name ASC').all();
  res.json({ factories: rows.map(r => r.name) });
});

router.get('/:id', requireAuth, requirePermission('concepts'), (req, res) => {
  const user = req.session.user;
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Not found' });
  if (user.role === 'buyer' && concept.department !== user.department) {
    return res.status(403).json({ error: 'Not authorized for this concept' });
  }
  attachCoverPhoto(concept);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
  const conversions = db.prepare('SELECT * FROM concept_conversions WHERE concept_id = ? ORDER BY created_at DESC').all(concept.id);
  const fabrics = db.prepare('SELECT * FROM concept_fabrics WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
  res.json({ concept: scopeConceptForRole(concept, user), photos, conversions, fabrics });
});

// ---- Create / edit / delete (buyers cannot) ----
// Accepts multipart/form-data so the concept's fields and its initial
// reference photos can be created in one atomic request - avoids the
// two-request "create, then separately upload" sequence that had photos
// silently going missing depending on exactly when the second request ran.
// Plain TEXT fields that need no special coercion (not department/
// concept_no/concept_date/spec_category_id/size_range_id, which all have
// their own defaulting/type handling below) - the rest of the single-drawer
// field set, so adding another simple text field later means touching this
// list, not the INSERT's positional params.
const CONCEPT_TEXT_FIELDS = [
  'description', 'source', 'tags', 'cost_estimate', 'factory', 'shipping_date',
  'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
  'topstitching', 'trims', 'styling', 'units', 'packing', 'labels', 'dc_date',
  'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price', 'factory_cost_options'
];

router.post('/', requireAuth, upload.array('photos', 10), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot create concepts' });
  const { department, concept_date, spec_category_id, size_range_id } = req.body || {};
  if (!department || !DEPT_CODES[department]) return res.status(400).json({ error: 'A valid department is required' });

  // A custom code can be typed in at creation instead of always taking the
  // next auto-generated one for the department (see the same
  // case-insensitive uniqueness check on PUT /:id's rename handling below).
  let conceptNo;
  const requestedConceptNo = (req.body.concept_no || '').toString().trim().toUpperCase();
  if (requestedConceptNo) {
    const clash = db.prepare('SELECT id FROM concepts WHERE UPPER(concept_no) = ?').get(requestedConceptNo);
    if (clash) return res.status(400).json({ error: `Concept code ${requestedConceptNo} is already in use` });
    conceptNo = requestedConceptNo;
  } else {
    conceptNo = nextConceptNo(department);
  }
  const finalConceptDate = concept_date || new Date().toISOString().slice(0, 7); // 'YYYY-MM' - editable afterwards

  const cols = ['concept_no', 'department', 'concept_date', 'spec_category_id', 'size_range_id', ...CONCEPT_TEXT_FIELDS];
  const values = [
    conceptNo, department, finalConceptDate,
    toIntOrNull(spec_category_id), toIntOrNull(size_range_id),
    ...CONCEPT_TEXT_FIELDS.map(f => (req.body[f] || '').toString().trim() || null)
  ];
  const info = db.prepare(`
    INSERT INTO concepts (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
  `).run(...values);
  const conceptId = info.lastInsertRowid;
  let photoError = null;
  if (req.files && req.files.length) {
    try {
      const insertPhoto = db.prepare('INSERT INTO concept_photos (concept_id, path, thumb_path) VALUES (?,?,?)');
      for (const f of req.files) {
        const { filename, thumbFilename } = await saveBufferAsWebpWithThumb(f.buffer, UPLOAD_DIR, `concept-${conceptId}`);
        insertPhoto.run(conceptId, '/uploads/' + filename, '/uploads/' + thumbFilename);
      }
    } catch (e) {
      // The concept itself is already created at this point - report the
      // photo failure rather than losing the whole concept over it.
      photoError = 'One or more photos could not be processed: ' + e.message;
    }
  }
  const created = db.prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId);
  attachCoverPhoto(created);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(conceptId);

  // Auto-generate the CAD from whatever reference photos were just
  // uploaded, same AI call as the manual "Generate CAD" button - fired
  // without awaiting it so concept creation itself isn't held up by a
  // 10-30s image generation call. Runs on in this same process after the
  // response below is sent; failures (missing API key, no usable photos,
  // OpenAI errors) just log server-side rather than surfacing to the
  // merchandiser, same as any other background job - the concept was
  // already created successfully regardless of whether this succeeds.
  if (openaiClient && !photoError && photos.length) {
    const usablePhotos = photos.filter(p => OPENAI_IMAGE_EXT.includes(path.extname(p.path).toLowerCase()));
    if (usablePhotos.length) {
      generateConceptCadFromPhotos(created, usablePhotos).catch(e => {
        console.error(`Auto CAD generation failed for ${created.concept_no}:`, e.message);
      });
    }
  }

  res.json({ concept: scopeConceptForRole(created, user), photos, photoError });
});

router.put('/:id', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot edit concepts' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });

  const fields = ['concept_date', 'cad_description', 'fabric_prefix', ...CONCEPT_TEXT_FIELDS];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (req.body.spec_category_id !== undefined) { updates.push('spec_category_id = ?'); values.push(toIntOrNull(req.body.spec_category_id)); }
  if (req.body.size_range_id !== undefined) { updates.push('size_range_id = ?'); values.push(toIntOrNull(req.body.size_range_id)); }

  // Changing department reassigns the concept's code, since its prefix is
  // department-derived (e.g. CL -> CM) - lets an early mistake be corrected
  // properly instead of leaving a permanently mismatched prefix.
  let newConceptNo = concept.concept_no;
  if (req.body.department !== undefined && req.body.department !== concept.department) {
    if (!DEPT_CODES[req.body.department]) return res.status(400).json({ error: 'Invalid department' });
    newConceptNo = nextConceptNo(req.body.department);
    updates.push('department = ?');
    values.push(req.body.department);
  }

  // A direct rename of the code itself (fixing a typo, renumbering, etc) -
  // wins over the auto-reassigned code above if both are sent together.
  // Case-insensitively unique since concept_no is used as a lookup key
  // elsewhere (CAD/report filenames, request emails).
  if (req.body.concept_no !== undefined) {
    const requested = (req.body.concept_no || '').toString().trim().toUpperCase();
    if (!requested) return res.status(400).json({ error: 'Concept code cannot be empty' });
    if (requested !== concept.concept_no) {
      const clash = db.prepare('SELECT id FROM concepts WHERE UPPER(concept_no) = ? AND id != ?').get(requested, concept.id);
      if (clash) return res.status(400).json({ error: `Concept code ${requested} is already in use` });
      newConceptNo = requested;
    }
  }

  // The main CAD image is named after the code, so it gets renamed to match
  // whenever the code actually changes (department-driven or manual) -
  // reference/detail photos are named by internal id, unaffected.
  if (newConceptNo !== concept.concept_no) {
    updates.push('concept_no = ?');
    values.push(newConceptNo);

    const cadPhoto = db.prepare("SELECT * FROM concept_photos WHERE concept_id = ? AND role = 'cad'").get(concept.id);
    if (cadPhoto) {
      const ext = path.extname(cadPhoto.path) || '.webp';
      const newFilename = newConceptNo.toLowerCase() + ext;
      try {
        fs.renameSync(resolveUploadPath(cadPhoto.path), path.join(CAD_DIR, newFilename));
        db.prepare('UPDATE concept_photos SET path = ? WHERE id = ?').run('/uploads/concepts/' + newFilename, cadPhoto.id);
      } catch (e) { /* file already missing on disk - nothing to rename */ }
    }
  }

  // Extra fabric slots for a multi-piece set (see concept_fabrics in db.js) -
  // sent as the full desired list each save and replaced wholesale, same
  // "just resend everything" approach as photo reordering, simpler than
  // per-slot CRUD for what's normally 1-2 rows.
  const fabricsProvided = req.body.fabrics !== undefined;
  if (fabricsProvided) {
    const fabrics = Array.isArray(req.body.fabrics) ? req.body.fabrics : [];
    db.prepare('DELETE FROM concept_fabrics WHERE concept_id = ?').run(concept.id);
    const insertFabric = db.prepare('INSERT INTO concept_fabrics (concept_id, prefix, fabric_code, composition, weight, sort_order) VALUES (?,?,?,?,?,?)');
    fabrics.forEach((f, i) => {
      insertFabric.run(
        concept.id,
        (f.prefix || '').toString().trim() || null,
        (f.fabric_code || '').toString().trim() || null,
        (f.composition || '').toString().trim() || null,
        (f.weight || '').toString().trim() || null,
        i
      );
    });
  }

  if (!updates.length && !fabricsProvided) return res.status(400).json({ error: 'No fields to update' });
  if (updates.length) {
    values.push(req.params.id);
    db.prepare(`UPDATE concepts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  }
  const updated = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  attachCoverPhoto(updated);
  const fabrics = db.prepare('SELECT * FROM concept_fabrics WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
  res.json({ concept: scopeConceptForRole(updated, user), fabrics });
});

router.delete('/:id', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Buyers cannot delete concepts' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Not found' });
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ?').all(concept.id);
  photos.forEach(p => {
    fs.unlink(resolveUploadPath(p.path), () => {});
    if (p.thumb_path) fs.unlink(resolveUploadPath(p.thumb_path), () => {});
  });
  db.prepare('DELETE FROM concept_photos WHERE concept_id = ?').run(concept.id);
  db.prepare('DELETE FROM concept_conversions WHERE concept_id = ?').run(concept.id);
  db.prepare('DELETE FROM concept_fabrics WHERE concept_id = ?').run(concept.id);
  db.prepare('DELETE FROM concepts WHERE id = ?').run(concept.id);
  res.json({ ok: true });
});

// ---- Photos ----
router.post('/:id/photos', requireAuth, upload.array('photos', 10), async (req, res) => {
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Not found' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No images received' });
  try {
    const insert = db.prepare('INSERT INTO concept_photos (concept_id, path, thumb_path) VALUES (?,?,?)');
    for (const f of req.files) {
      const { filename, thumbFilename } = await saveBufferAsWebpWithThumb(f.buffer, UPLOAD_DIR, `concept-${concept.id}`);
      insert.run(concept.id, '/uploads/' + filename, '/uploads/' + thumbFilename);
    }
  } catch (e) {
    return res.status(400).json({ error: 'Could not process one or more images: ' + e.message });
  }
  db.prepare('UPDATE concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(concept.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);

  // Mobile's "create" flow uploads photos as a second, backgrounded step
  // (see POST '/' above) so the merchandiser isn't stuck waiting on image
  // processing before moving to the next concept - it asks for the same
  // auto-CAD trigger here, once the photos it just uploaded have actually
  // landed. Not fired for ordinary photo top-ups on an existing concept,
  // which already has its own manual "Generate/Regenerate AI" button.
  if (req.body.autoCad === '1' && openaiClient) {
    const usablePhotos = photos.filter(p => OPENAI_IMAGE_EXT.includes(path.extname(p.path).toLowerCase()));
    if (usablePhotos.length) {
      generateConceptCadFromPhotos(concept, usablePhotos).catch(e => {
        console.error(`Auto CAD generation failed for ${concept.concept_no}:`, e.message);
      });
    }
  }

  res.json({ photos });
});

// Persists a new photo order after a drag-and-drop reorder in the drawer.
// Whichever photo ends up at position 0 becomes the board thumbnail.
router.put('/:id/photos/reorder', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const { order } = req.body || {};
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order array is required' });
  const update = db.prepare('UPDATE concept_photos SET sort_order = ? WHERE id = ? AND concept_id = ?');
  order.forEach((photoId, i) => update.run(i, photoId, req.params.id));
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  res.json({ photos });
});

router.delete('/:id/photos/:photoId', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const photo = db.prepare('SELECT * FROM concept_photos WHERE id = ? AND concept_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  fs.unlink(resolveUploadPath(photo.path), () => {});
  if (photo.thumb_path) fs.unlink(resolveUploadPath(photo.thumb_path), () => {});
  db.prepare('DELETE FROM concept_photos WHERE id = ?').run(photo.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  res.json({ photos });
});

// Updates which "role" a photo plays - lets the team tag reference shots
// vs sourced detail crops vs the final CAD sheet.
router.put('/:id/photos/:photoId/role', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const { role } = req.body || {};
  if (!['reference', 'detail', 'cad'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  const photo = db.prepare('SELECT * FROM concept_photos WHERE id = ? AND concept_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  db.prepare('UPDATE concept_photos SET role = ? WHERE id = ?').run(role, photo.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  res.json({ photos });
});

// Renames a photo's label - used for the CAD tab's labeled detail crops
// (e.g. "BUTTON DETAIL"), edited inline in the sidebar.
router.put('/:id/photos/:photoId/label', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const { label } = req.body || {};
  const photo = db.prepare('SELECT * FROM concept_photos WHERE id = ? AND concept_id = ?').get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  db.prepare('UPDATE concept_photos SET label = ? WHERE id = ?').run((label || '').trim(), photo.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  res.json({ photos });
});

// Lets someone manually upload/override the main CAD image directly,
// bypassing AI generation entirely - the escape hatch for when the AI
// result isn't usable and a hand-made flat needs to go in its place.
router.post('/:id/cad-main', requireAuth, upload.single('photo'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });

  const filename = `${concept.concept_no.toLowerCase()}.webp`;
  try {
    await convertBufferToWebpFile(req.file.buffer, path.join(CAD_DIR, filename));
  } catch (e) {
    return res.status(400).json({ error: 'Could not process that image: ' + e.message });
  }
  // Replace any previous CAD entry rather than stacking duplicates that
  // would all point at the same (now overwritten) file.
  db.prepare("DELETE FROM concept_photos WHERE concept_id = ? AND role = 'cad'").run(concept.id);
  db.prepare('INSERT INTO concept_photos (concept_id, path, role) VALUES (?,?,?)').run(concept.id, '/uploads/concepts/' + filename, 'cad');
  db.prepare('UPDATE concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(concept.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
  res.json({ photos });
});

// Adds one labeled detail crop (button, rivet, stitching close-up, etc.) to
// the CAD tab's sidebar - unlimited, each with its own label, kept separate
// from the main reference/detail photo grid on the Details tab.
router.post('/:id/cad-details', requireAuth, upload.single('photo'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  if (!req.file) return res.status(400).json({ error: 'An image file is required' });
  const label = (req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'A label is required' });

  let filename;
  try {
    filename = await saveBufferAsWebp(req.file.buffer, UPLOAD_DIR, `concept-${concept.id}`);
  } catch (e) {
    return res.status(400).json({ error: 'Could not process that image: ' + e.message });
  }
  db.prepare('INSERT INTO concept_photos (concept_id, path, role, label) VALUES (?,?,?,?)')
    .run(concept.id, '/uploads/' + filename, 'cad_detail', label);
  db.prepare('UPDATE concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(concept.id);
  const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
  res.json({ photos });
});

// Sends selected reference photos to OpenAI's image model and saves the
// result back as a photo tagged 'cad'. Costs real money per call - this is
// a genuine AI generation, not a local filter.
//
// Prompt below is the exact combination confirmed working well in testing:
// gpt-image-1.5, input_fidelity 'high', quality 'high', both photos in one
// call, and this detailed "replication task, not a design task" prompt.
// OpenAI's image model only accepts jpeg/png/webp input - confirmed via its
// own rejection error for both gif and avif ("Supported file formats are
// 'image/jpeg', 'image/png', and 'image/webp'"). An allowlist here is more
// robust than excluding known-bad formats one at a time.
const OPENAI_IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Shared by the manual "Generate CAD" button (POST :id/generate-cad-ai
// below) and the auto-trigger fired right after a new concept is created
// with photos (see POST '/' above) - same AI call and same save-as-role='cad'
// result either way, callers just differ in whether they await it for a
// response or fire-and-forget it in the background.
async function generateConceptCadFromPhotos(concept, photoRows) {
  const imageFiles = await Promise.all(photoRows.map(p => {
    const fullPath = resolveUploadPath(p.path);
    return toFile(fs.createReadStream(fullPath), null, { type: mimeFromExt(fullPath) });
  }));

  const prompt = `Using the attached reference images, create a high-end photograph of the front and back of the garment${concept.description ? ' ("' + concept.description + '")' : ''}, as if it were laid flat on a plain white floor/surface and photographed from directly above with soft, even natural lighting - a real photo of a physical garment on a plain white background, not a flat vector illustration or CAD-style graphic. Show realistic fabric texture, weight and drape, with natural folds and soft shadows consistent with real fabric resting on a flat surface.

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
  const filename = `${concept.concept_no.toLowerCase()}.webp`;
  await convertBufferToWebpFile(buffer, path.join(CAD_DIR, filename));
  // Replace any previous CAD entry rather than stacking duplicates that
  // would all point at the same (now overwritten) file.
  db.prepare("DELETE FROM concept_photos WHERE concept_id = ? AND role = 'cad'").run(concept.id);
  db.prepare('INSERT INTO concept_photos (concept_id, path, role) VALUES (?,?,?)').run(concept.id, '/uploads/concepts/' + filename, 'cad');
  db.prepare('UPDATE concepts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(concept.id);
}

router.post('/:id/generate-cad-ai', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  if (!openaiClient) return res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server (.env)' });

  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });

  const { photoIds } = req.body || {};
  if (!Array.isArray(photoIds) || !photoIds.length) return res.status(400).json({ error: 'photoIds array is required' });

  const photoRows = photoIds
    .map(id => db.prepare('SELECT * FROM concept_photos WHERE id = ? AND concept_id = ?').get(id, concept.id))
    .filter(Boolean)
    .filter(p => OPENAI_IMAGE_EXT.includes(path.extname(p.path).toLowerCase()));

  if (!photoRows.length) return res.status(400).json({ error: 'No usable reference photos (must be jpg, png or webp - gif and avif are not supported as AI input)' });

  try {
    await generateConceptCadFromPhotos(concept, photoRows);
    const photos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id);
    res.json({ photos });
  } catch (e) {
    console.error('CAD AI generation failed:', e.message);
    res.status(500).json({ error: 'AI generation failed: ' + (e.message || 'unknown error') });
  }
});

// Wraps a composited CAD sheet (built client-side on canvas) into a real
// PDF and streams it back for download. Also keeps a copy on disk next to
// the CAD image so it doesn't need regenerating every time.
router.post('/:id/export-cad-pdf', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
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

    const filename = `${concept.concept_no.toLowerCase()}.pdf`;
    fs.writeFileSync(path.join(CAD_DIR, filename), pdfBytes);

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));
  } catch (e) {
    console.error('PDF export failed:', e.message);
    res.status(500).json({ error: 'PDF export failed: ' + e.message });
  }
});

// Builds "Ladies > Denim > Short" from a leaf spec_categories id, same
// parent-walk as drawer.js's client-side specCategoryPath - needed here too
// since it's used server-side (see send-costing-email below).
function specCategoryPathServer(id) {
  const byId = {};
  db.prepare('SELECT id, parent_id, name FROM spec_categories').all().forEach(n => { byId[n.id] = n; });
  const names = [];
  let cur = byId[id];
  while (cur) { names.unshift(cur.name); cur = cur.parent_id ? byId[cur.parent_id] : null; }
  return names.join(' > ');
}

// Feeds the "Copy to clipboard" button's HTML table template (see
// buildCostingEmailHtml in public/js/concepts.js) with the AI-translated
// field values and the static LABELS map, so the pasted-into-email version
// stays terminologically in sync with the real Send pipeline's wording
// rather than drifting as its own hand-maintained copy. JSON, not a
// document - the client builds the actual markup so it can also embed the
// photos it already has loaded as data URLs (see loadImageAsDataUrl).
router.get('/:id/costing-email-data', requireAuth, requirePermission('concepts'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });

  const specPath = concept.spec_category_id ? specCategoryPathServer(concept.spec_category_id) : null;
  try {
    const translations = await translateConceptFields({ ...concept, specPath }, openaiClient);
    res.json({ concept, specPath, translations, labels: LABELS });
  } catch (e) {
    console.error('Costing email data failed:', e.message);
    res.status(500).json({ error: 'Failed to prepare costing request: ' + e.message });
  }
});

// Best-guess recipient for the Send button: a Factory contact belonging to
// the factories-table row whose name matches this concept's free-text
// Factory field. Exact match first (case-insensitive), then a loose
// substring match either direction (e.g. concept.factory "Golden Sun"
// matching a saved "Golden Sun Garments Ltd"), so a close-enough name still
// prefills - the frontend always shows the picked contact's name before
// sending, and lets the user pick a different saved contact or type an
// address by hand instead. `company` is aliased from factories.name so the
// existing frontend consumers (this drawer's composer, the Style drawer's,
// and the MCP tool) don't need to change shape.
router.get('/:id/factory-contact', requireAuth, requirePermission('concepts'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });

  const factoryContacts = db.prepare(`
    SELECT c.*, f.name AS company FROM contacts c
    JOIN factories f ON f.id = c.factory_id
    ORDER BY f.name ASC
  `).all();
  let match = null;
  if (concept.factory && concept.factory.trim()) {
    const needle = concept.factory.trim().toLowerCase();
    match = factoryContacts.find(c => (c.company || '').trim().toLowerCase() === needle)
      || factoryContacts.find(c => {
        const company = (c.company || '').trim().toLowerCase();
        return company && (company.includes(needle) || needle.includes(company));
      })
      || null;
  }
  res.json({ match, factoryContacts });
});

// Every request type this concept has sent, newest first - feeds the
// Concept drawer's Requests tab. Separate from GET /api/requests (the
// all-concepts list behind the main Requests nav section) since the drawer
// only ever needs one concept's own history, not the whole company's.
router.get('/:id/requests', requireAuth, requirePermission('concepts'), (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const rows = db.prepare(`
    SELECT id, concept_id, concept_no, concept_description, request_type, message, sent_to, sent_by_name, subject, resend_id, status, received_at, reminder_count, last_reminder_at, created_at
    FROM concept_requests WHERE concept_id = ? ORDER BY created_at DESC
  `).all(req.params.id);
  res.json({ requests: rows });
});

// Actually sends a factory request - cost/quotation (built from the
// concept's own Details/Costing fields, see lib/conceptCostingEmailHtml.js)
// or one of the free-text types (sample/PP sample/bulk sample/fabric test,
// see lib/conceptGenericRequestEmailHtml.js) - via Resend's HTTP API (see
// lib/mailer.js). Photos are embedded as base64 data URIs directly in the
// HTML, same approach as the clipboard-paste version uses client-side.
// Every send is logged to concept_requests (exact HTML included) so it
// shows up in the Requests section as a permanent record of what was sent,
// when, and to whom.
router.post('/:id/send-request', requireAuth, requirePermission('concepts'), async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  if (!mailIsConfigured()) return res.status(500).json({ error: 'Email sending is not configured on the server' });

  const recipients = parseRecipients(req.body && req.body.to);
  if (!recipients.length) {
    return res.status(400).json({ error: 'A valid recipient email is required' });
  }
  const to = recipients.join(', ');
  const requestType = (req.body && req.body.request_type) || 'cost';
  if (!REQUEST_TYPES[requestType]) return res.status(400).json({ error: 'Invalid request type' });
  const message = (req.body && req.body.message || '').trim();
  if (requestType !== 'cost' && !message) {
    return res.status(400).json({ error: 'A message is required for this request type' });
  }

  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });

  const specPath = concept.spec_category_id ? specCategoryPathServer(concept.spec_category_id) : null;
  const photoRows = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id)
    .filter(p => p.role !== 'cad' && p.role !== 'cad_detail');

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
        // Every concept photo is saved as .webp (see lib/imageConvert.js) -
        // converted to PNG here since inline webp rendering in mail clients
        // is unreliable, same reasoning as the old PDF export.
        const pngBuffer = await sharp(fullPath).png().toBuffer();
        photos.push({ dataUrl: 'data:image/png;base64,' + pngBuffer.toString('base64') });
      } catch (e) { /* a broken/unreadable photo shouldn't fail the whole send */ }
    }

    let html, text, subject;
    if (requestType === 'cost') {
      const translations = await translateConceptFields({ ...concept, specPath }, openaiClient);
      html = buildCostingEmailHtml({ concept, specPath, translations, logoDataUrl, photos });
      text = buildCostingPlainText(concept, specPath);
      subject = `Quotation - ${concept.concept_no} - ${concept.description || ''}`;
    } else {
      const messageZh = await translateMessage(message, openaiClient);
      html = buildGenericRequestEmailHtml({ concept, requestType, message, messageZh, logoDataUrl, photos });
      text = buildGenericRequestPlainText({ concept, requestType, message });
      subject = `${REQUEST_TYPES[requestType].en} - ${concept.concept_no} - ${concept.description || ''}`;
    }

    const { from, replyTo } = resolveSender(user);
    const result = await sendMail({ to: recipients, subject, html, text, from, replyTo });

    db.prepare(`
      INSERT INTO concept_requests (concept_id, concept_no, concept_description, request_type, message, sent_to, sent_by_name, subject, html, resend_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(concept.id, concept.concept_no, concept.description || '', requestType, requestType === 'cost' ? null : message, to, user.name || '', subject, html, result.id || null);

    res.json({ ok: true });
  } catch (e) {
    console.error('Request send failed:', e.message);
    res.status(500).json({ error: 'Failed to send: ' + e.message });
  }
});

// ---- Conversion logging (called by the frontend right after a style is
// created from this concept - see drawer.js saveStyle) ----
router.post('/:id/conversions', requireAuth, (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const concept = db.prepare('SELECT * FROM concepts WHERE id = ?').get(req.params.id);
  if (!concept) return res.status(404).json({ error: 'Concept not found' });
  const { style_id, style_no } = req.body || {};
  if (!style_id || !style_no) return res.status(400).json({ error: 'style_id and style_no are required' });
  db.prepare('INSERT INTO concept_conversions (concept_id, style_id, style_no) VALUES (?,?,?)').run(concept.id, style_id, style_no);
  const conversions = db.prepare('SELECT * FROM concept_conversions WHERE concept_id = ? ORDER BY created_at DESC').all(concept.id);
  res.json({ conversions });
});

// Copies this concept's photos over to a newly-created style, so a
// converted concept doesn't need re-photographing. Reference photos are
// copied first (plain 'reference' role, default cover-photo candidates);
// the concept's generated/uploaded CAD image - if any - is copied last and
// explicitly tagged role='cad', landing in the same uploads/styles/<style_no>
// convention the style's own CAD routes use, so it's immediately recognized
// as the style's CAD image rather than just another reference photo. Detail
// crops (role='cad_detail') aren't carried over - that feature isn't part
// of the style CAD tab.
router.post('/:id/copy-photos-to-style/:styleId', requireAuth, async (req, res) => {
  const user = req.session.user;
  if (user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  const style = db.prepare('SELECT style_no FROM styles WHERE id = ?').get(req.params.styleId);
  if (!style) return res.status(404).json({ error: 'Style not found' });
  const conceptPhotos = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(req.params.id);
  if (!conceptPhotos.length) return res.json({ copied: 0 });

  const insertRef = db.prepare('INSERT INTO photos (style_id, path, thumb_path) VALUES (?,?,?)');
  const insertCad = db.prepare("INSERT INTO photos (style_id, path, role) VALUES (?,?,'cad')");
  const styleCadDir = path.join(UPLOAD_DIR, 'styles');
  fs.mkdirSync(styleCadDir, { recursive: true });
  let copied = 0;

  for (const p of conceptPhotos.filter(p => p.role !== 'cad' && p.role !== 'cad_detail')) {
    const ext = path.extname(p.path);
    const destName = `style-${req.params.styleId}-${Date.now()}-${Math.random().toString(36).slice(2,8)}${ext}`;
    try {
      fs.copyFileSync(resolveUploadPath(p.path), path.join(UPLOAD_DIR, destName));
      let thumbUrl = null;
      const thumbName = destName.replace(ext, '') + '-thumb.webp';
      try {
        if (p.thumb_path) {
          fs.copyFileSync(resolveUploadPath(p.thumb_path), path.join(UPLOAD_DIR, thumbName));
        } else {
          await makeThumbnailFile(fs.readFileSync(resolveUploadPath(p.path)), path.join(UPLOAD_DIR, thumbName));
        }
        thumbUrl = '/uploads/' + thumbName;
      } catch (e) { /* missing/ungeneratable thumb shouldn't block copying the full photo */ }
      insertRef.run(req.params.styleId, '/uploads/' + destName, thumbUrl);
      copied++;
    } catch (e) { /* skip missing files silently */ }
  }

  const cadPhoto = conceptPhotos.find(p => p.role === 'cad');
  if (cadPhoto) {
    const ext = path.extname(cadPhoto.path) || '.webp';
    const destName = style.style_no.toLowerCase() + ext;
    try {
      fs.copyFileSync(resolveUploadPath(cadPhoto.path), path.join(styleCadDir, destName));
      insertCad.run(req.params.styleId, '/uploads/styles/' + destName);
      copied++;
    } catch (e) { /* skip missing files silently */ }
  }

  res.json({ copied });
});

router.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

module.exports = router;