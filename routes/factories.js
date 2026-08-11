const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Section-level gate: can this user reach Factories at all. Independent of
// role - see db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('factories'));

// Buyers are read-mostly everywhere else in the app and stay that way here
// too, even once granted the 'factories' permission.
function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM contacts c WHERE c.factory_id = f.id) AS contact_count
    FROM factories f ORDER BY f.name ASC
  `).all();
  res.json({ factories: rows });
});

router.get('/:id', (req, res) => {
  const factory = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  if (!factory) return res.status(404).json({ error: 'Factory not found' });
  const contacts = db.prepare('SELECT * FROM contacts WHERE factory_id = ? ORDER BY last_name ASC').all(factory.id);
  res.json({ factory, contacts });
});

router.post('/', blockBuyerWrite, (req, res) => {
  const { name, registered_name, address, certifications, country, importer_vendor_code } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Factory name is required' });
  const info = db.prepare(`
    INSERT INTO factories (name, registered_name, address, certifications, country, importer_vendor_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name.trim(), (registered_name || '').trim() || null, (address || '').trim() || null, (certifications || '').trim() || null, (country || '').trim() || null, (importer_vendor_code || '').trim() || null);
  const created = db.prepare('SELECT * FROM factories WHERE id = ?').get(info.lastInsertRowid);
  res.json({ factory: created });
});

router.put('/:id', blockBuyerWrite, (req, res) => {
  const factory = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  if (!factory) return res.status(404).json({ error: 'Factory not found' });
  if (req.body.name !== undefined && !req.body.name.trim()) {
    return res.status(400).json({ error: 'Factory name is required' });
  }
  const fields = ['name', 'registered_name', 'address', 'certifications', 'country', 'importer_vendor_code'];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE factories SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  res.json({ factory: updated });
});

router.delete('/:id', blockBuyerWrite, (req, res) => {
  const factory = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  if (!factory) return res.status(404).json({ error: 'Factory not found' });
  // Unlink rather than delete its contacts - a person record shouldn't
  // disappear just because the factory entity they were filed under does.
  db.prepare('UPDATE contacts SET factory_id = NULL WHERE factory_id = ?').run(factory.id);
  db.prepare('DELETE FROM factories WHERE id = ?').run(factory.id);
  res.json({ ok: true });
});

// ---- Nested contacts (the people who work at this factory) ----
// Factory contacts live in the same `contacts` table as everyone else
// (position='Factory'), just scoped by factory_id instead of the old
// free-text company match - see db.js's comment on the factories table.

router.post('/:id/contacts', blockBuyerWrite, (req, res) => {
  const factory = db.prepare('SELECT * FROM factories WHERE id = ?').get(req.params.id);
  if (!factory) return res.status(404).json({ error: 'Factory not found' });
  const { first_name, last_name, job_title, phone, email } = req.body || {};
  if (!first_name || !last_name) return res.status(400).json({ error: 'First name and last name are required' });
  const info = db.prepare(`
    INSERT INTO contacts (first_name, last_name, position, job_title, phone, email, factory_id)
    VALUES (?, ?, 'Factory', ?, ?, ?, ?)
  `).run(first_name.trim(), last_name.trim(), (job_title || '').trim(), (phone || '').trim(), (email || '').trim(), factory.id);
  const created = db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid);
  res.json({ contact: created });
});

router.put('/:id/contacts/:contactId', blockBuyerWrite, (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ? AND factory_id = ?').get(req.params.contactId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const fields = ['first_name', 'last_name', 'job_title', 'phone', 'email'];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(contact.id);
  db.prepare(`UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  res.json({ contact: updated });
});

router.delete('/:id/contacts/:contactId', blockBuyerWrite, (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ? AND factory_id = ?').get(req.params.contactId, req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);
  res.json({ ok: true });
});

module.exports = router;
