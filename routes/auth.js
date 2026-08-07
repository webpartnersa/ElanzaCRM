const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email||'').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role, retailer: user.retailer, department: user.department, permissions: user.permissions || '' };
  res.json({ user: req.session.user });
});

router.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

router.get('/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: req.session.user });
});

// Any logged-in user can change their own password (must know current one)
router.post('/me/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  res.json({ ok: true });
});

module.exports = router;
