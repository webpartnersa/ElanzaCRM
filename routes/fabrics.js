const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Section-level gate: can this user reach Fabrics at all. Independent of
// role - see db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('fabrics'));

// Buyers are read-mostly everywhere else in the app and stay that way here
// too, even once granted the 'fabrics' permission.
function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM fabrics ORDER BY code ASC').all();
  res.json({ fabrics: rows });
});

router.post('/', blockBuyerWrite, (req, res) => {
  const { code, composition, report_number, approval_date } = req.body || {};
  if (!code || !code.trim()) return res.status(400).json({ error: 'Fabric code is required' });
  try {
    const info = db.prepare(`
      INSERT INTO fabrics (code, composition, report_number, approval_date)
      VALUES (?,?,?,?)
    `).run(code.trim(), (composition || '').trim(), (report_number || '').trim(), approval_date || null);
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
  const fields = ['code', 'composition', 'report_number', 'approval_date'];
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
  db.prepare('DELETE FROM fabrics WHERE id = ?').run(fabric.id);
  res.json({ ok: true });
});

module.exports = router;
