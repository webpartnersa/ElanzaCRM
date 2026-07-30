const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { publicUser } = require('../lib/scope');

const router = express.Router();

const VALID_SECTIONS = ['styles', 'concepts', 'shipping', 'contacts', 'fabrics'];
function sanitizePermissions(perms, role) {
  if (!Array.isArray(perms)) return role === 'buyer' ? 'styles,concepts' : VALID_SECTIONS.join(',');
  return perms.filter(p => VALID_SECTIONS.includes(p)).join(',');
}

router.get('/', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  res.json({ users: users.map(publicUser) });
});

router.post('/', requireAdmin, (req, res) => {
  const { name, email, password, role, retailer, department, permissions } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Name, email, password and role are required' });
  }
  if (!['admin','merchandiser','buyer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (role === 'buyer' && (!retailer || !department)) {
    return res.status(400).json({ error: 'Buyer accounts need a retailer and department' });
  }
  try {
    const info = db.prepare(
      `INSERT INTO users (name,email,password_hash,role,retailer,department,permissions) VALUES (?,?,?,?,?,?,?)`
    ).run(name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), role,
      role==='buyer' ? retailer : null, role==='buyer' ? department : null, sanitizePermissions(permissions, role));
    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.json({ user: publicUser(created) });
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'A user with that email already exists' });
    res.status(500).json({ error: 'Could not create user' });
  }
});

router.put('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const { name, role, retailer, department, new_password, permissions } = req.body || {};

  if (role && !['admin','merchandiser','buyer'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (target.role === 'admin' && role && role !== 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }

  const updates = [];
  const values = [];
  if (name) { updates.push('name = ?'); values.push(name.trim()); }
  if (role) {
    updates.push('role = ?'); values.push(role);
    updates.push('retailer = ?'); values.push(role==='buyer' ? (retailer||null) : null);
    updates.push('department = ?'); values.push(role==='buyer' ? (department||null) : null);
  }
  if (Array.isArray(permissions)) {
    updates.push('permissions = ?'); values.push(sanitizePermissions(permissions, role || target.role));
  }
  if (new_password) {
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    updates.push('password_hash = ?'); values.push(bcrypt.hashSync(new_password, 10));
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  res.json({ user: publicUser(updated) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.id === req.session.user.id) return res.status(400).json({ error: "You can't delete your own account" });
  if (target.role === 'admin') {
    const adminCount = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin'`).get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'Cannot remove the last admin account' });
  }
  db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
