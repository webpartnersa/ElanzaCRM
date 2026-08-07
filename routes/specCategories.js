const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Section-level gate: this tree only exists to feed the Concepts drawer's
// Spec picker, so it's gated the same as Concepts itself, not its own
// permission.
router.use(requireAuth, requirePermission('concepts'));

function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

// Collects a node and every descendant's id, depth-first - used by DELETE
// to wipe a whole subtree in one go rather than leaving orphaned children.
function collectSubtreeIds(rootId) {
  const all = db.prepare('SELECT id, parent_id FROM spec_categories').all();
  const byParent = {};
  all.forEach(n => { (byParent[n.parent_id] = byParent[n.parent_id] || []).push(n.id); });
  const ids = [rootId];
  let frontier = [rootId];
  while (frontier.length) {
    const next = [];
    frontier.forEach(id => (byParent[id] || []).forEach(childId => next.push(childId)));
    ids.push(...next);
    frontier = next;
  }
  return ids;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM spec_categories ORDER BY department ASC, sort_order ASC, name ASC').all();
  res.json({ categories: rows });
});

router.post('/', blockBuyerWrite, (req, res) => {
  const { name, parent_id } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'A category name is required' });

  let department;
  if (parent_id) {
    const parent = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(parent_id);
    if (!parent) return res.status(404).json({ error: 'Parent category not found' });
    department = parent.department; // children always inherit the root's department
  } else {
    department = (req.body.department || '').trim();
    if (!department) return res.status(400).json({ error: 'A department is required for a top-level category' });
  }

  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM spec_categories WHERE parent_id IS ?').get(parent_id || null);
  const info = db.prepare(`
    INSERT INTO spec_categories (department, parent_id, name, sort_order)
    VALUES (?,?,?,?)
  `).run(department, parent_id || null, name.trim(), (maxOrder.m || 0) + 1);
  const created = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(info.lastInsertRowid);
  res.json({ category: created });
});

router.put('/:id', blockBuyerWrite, (req, res) => {
  const node = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Category not found' });
  const { name, sort_order } = req.body || {};
  const updates = [];
  const values = [];
  if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' }); updates.push('name = ?'); values.push(name.trim()); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE spec_categories SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(req.params.id);
  res.json({ category: updated });
});

// Deletes this node and its whole subtree, and clears spec_category_id on
// any concept or style that pointed at one of the deleted nodes - the tree
// can be mid-restructure at any time, concepts/styles should never end up
// FK'd to a row that no longer exists. A style's own copied measurement
// sheet (style_spec_poms/style_spec_fits) is untouched - it's a frozen
// snapshot independent of the bank row it came from, not a live reference.
router.delete('/:id', blockBuyerWrite, (req, res) => {
  const node = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: 'Category not found' });
  const ids = collectSubtreeIds(node.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE concepts SET spec_category_id = NULL WHERE spec_category_id IN (${placeholders})`).run(...ids);
  db.prepare(`UPDATE styles SET spec_category_id = NULL WHERE spec_category_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM spec_category_poms WHERE spec_category_id IN (${placeholders})`).run(...ids);
  db.prepare(`DELETE FROM spec_categories WHERE id IN (${placeholders})`).run(...ids);
  res.json({ ok: true });
});

// ---- POM bank: the reference measurement list for a leaf category (see
// spec_category_poms in db.js). Reordering is done client-side as two PUTs
// swapping adjacent sort_order values, rather than a dedicated endpoint -
// mirrors how spec_categories itself has no reorder route either. ----

router.get('/:id/poms', (req, res) => {
  const category = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const poms = db.prepare('SELECT * FROM spec_category_poms WHERE spec_category_id = ? ORDER BY sort_order ASC, id ASC').all(category.id);
  res.json({ poms });
});

router.post('/:id/poms', blockBuyerWrite, (req, res) => {
  const category = db.prepare('SELECT * FROM spec_categories WHERE id = ?').get(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const { name, spec_to_be } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'A point of measure name is required' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM spec_category_poms WHERE spec_category_id = ?').get(category.id);
  const info = db.prepare(`
    INSERT INTO spec_category_poms (spec_category_id, name, spec_to_be, sort_order)
    VALUES (?,?,?,?)
  `).run(category.id, name.trim(), (spec_to_be || '').toString().trim() || null, (maxOrder.m || 0) + 1);
  const created = db.prepare('SELECT * FROM spec_category_poms WHERE id = ?').get(info.lastInsertRowid);
  res.json({ pom: created });
});

router.put('/poms/:pomId', blockBuyerWrite, (req, res) => {
  const pom = db.prepare('SELECT * FROM spec_category_poms WHERE id = ?').get(req.params.pomId);
  if (!pom) return res.status(404).json({ error: 'Point of measure not found' });
  const { name, spec_to_be, sort_order } = req.body || {};
  const updates = [];
  const values = [];
  if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' }); updates.push('name = ?'); values.push(name.trim()); }
  if (spec_to_be !== undefined) { updates.push('spec_to_be = ?'); values.push((spec_to_be || '').toString().trim() || null); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); values.push(sort_order); }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.pomId);
  db.prepare(`UPDATE spec_category_poms SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM spec_category_poms WHERE id = ?').get(req.params.pomId);
  res.json({ pom: updated });
});

router.delete('/poms/:pomId', blockBuyerWrite, (req, res) => {
  const pom = db.prepare('SELECT * FROM spec_category_poms WHERE id = ?').get(req.params.pomId);
  if (!pom) return res.status(404).json({ error: 'Point of measure not found' });
  db.prepare('DELETE FROM spec_category_poms WHERE id = ?').run(pom.id);
  res.json({ ok: true });
});

module.exports = router;
