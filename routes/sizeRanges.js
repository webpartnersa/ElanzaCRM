const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth, requirePermission('concepts'));

function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

function loadRangeWithValues(id) {
  const range = db.prepare('SELECT * FROM size_ranges WHERE id = ?').get(id);
  if (!range) return null;
  const values = db.prepare('SELECT value FROM size_range_values WHERE size_range_id = ? ORDER BY sort_order ASC, id ASC').all(id).map(v => v.value);
  return { ...range, values };
}

router.get('/', (req, res) => {
  const ranges = db.prepare('SELECT id FROM size_ranges ORDER BY id ASC').all().map(r => loadRangeWithValues(r.id));
  res.json({ ranges });
});

// name is auto-derived from the values (e.g. "S / M / L") rather than
// separately typed - a size range IS its list of values, nothing more.
router.post('/', blockBuyerWrite, (req, res) => {
  const values = (req.body && req.body.values || []).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) return res.status(400).json({ error: 'At least one size value is required' });
  const name = values.join(' / ');
  try {
    const info = db.prepare('INSERT INTO size_ranges (name) VALUES (?)').run(name);
    const insertValue = db.prepare('INSERT INTO size_range_values (size_range_id, value, sort_order) VALUES (?,?,?)');
    values.forEach((v, i) => insertValue.run(info.lastInsertRowid, v, i));
    res.json({ range: loadRangeWithValues(info.lastInsertRowid) });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `A size range of "${name}" already exists` });
    res.status(500).json({ error: 'Could not create size range' });
  }
});

router.put('/:id', blockBuyerWrite, (req, res) => {
  const range = db.prepare('SELECT * FROM size_ranges WHERE id = ?').get(req.params.id);
  if (!range) return res.status(404).json({ error: 'Size range not found' });
  const values = (req.body && req.body.values || []).map(v => String(v).trim()).filter(Boolean);
  if (!values.length) return res.status(400).json({ error: 'At least one size value is required' });
  const name = values.join(' / ');
  try {
    db.prepare('UPDATE size_ranges SET name = ? WHERE id = ?').run(name, req.params.id);
    db.prepare('DELETE FROM size_range_values WHERE size_range_id = ?').run(req.params.id);
    const insertValue = db.prepare('INSERT INTO size_range_values (size_range_id, value, sort_order) VALUES (?,?,?)');
    values.forEach((v, i) => insertValue.run(req.params.id, v, i));
    res.json({ range: loadRangeWithValues(req.params.id) });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: `A size range of "${name}" already exists` });
    res.status(500).json({ error: 'Could not update size range' });
  }
});

router.delete('/:id', blockBuyerWrite, (req, res) => {
  const range = db.prepare('SELECT * FROM size_ranges WHERE id = ?').get(req.params.id);
  if (!range) return res.status(404).json({ error: 'Size range not found' });
  db.prepare('UPDATE concepts SET size_range_id = NULL WHERE size_range_id = ?').run(range.id);
  db.prepare('DELETE FROM size_range_values WHERE size_range_id = ?').run(range.id);
  db.prepare('DELETE FROM size_ranges WHERE id = ?').run(range.id);
  res.json({ ok: true });
});

module.exports = router;
