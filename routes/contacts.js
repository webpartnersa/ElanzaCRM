const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

const POSITIONS = ['Buyer', 'Planner', 'QC', 'Other'];

// Section-level gate: can this user reach Contacts at all. Independent of
// role - see db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('contacts'));

// Buyers are read-mostly everywhere else in the app and stay that way here
// too, even once granted the 'contacts' permission.
function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

router.get('/', (req, res) => {
  const user = req.session.user;
  // A buyer only ever needs contacts for their own retailer+department -
  // the whole company directory (other retailers' buyer names, numbers,
  // emails) isn't theirs to see, same scoping principle as Styles.
  const rows = user.role === 'buyer'
    ? db.prepare('SELECT * FROM contacts WHERE retailer = ? AND department = ? ORDER BY last_name ASC').all(user.retailer, user.department)
    : db.prepare('SELECT * FROM contacts ORDER BY retailer ASC, department ASC, last_name ASC').all();
  res.json({ contacts: rows });
});

router.post('/', blockBuyerWrite, (req, res) => {
  const { first_name, last_name, position, phone, email, retailer, department } = req.body || {};
  if (!first_name || !last_name || !retailer || !department) {
    return res.status(400).json({ error: 'First name, last name, retailer and department are required' });
  }
  if (position && !POSITIONS.includes(position)) {
    return res.status(400).json({ error: 'Invalid position' });
  }
  const info = db.prepare(`
    INSERT INTO contacts (first_name, last_name, position, phone, email, retailer, department)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    first_name.trim(), last_name.trim(), position || 'Other',
    (phone || '').trim(), (email || '').trim(), retailer.trim(), department.trim()
  );
  const created = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ contact: created });
});

router.put('/:id', blockBuyerWrite, (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  if (req.body.position !== undefined && req.body.position && !POSITIONS.includes(req.body.position)) {
    return res.status(400).json({ error: 'Invalid position' });
  }
  const fields = ['first_name', 'last_name', 'position', 'phone', 'email', 'retailer', 'department'];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  res.json({ contact: updated });
});

router.delete('/:id', blockBuyerWrite, (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  res.json({ ok: true });
});

module.exports = router;
