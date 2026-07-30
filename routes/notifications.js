const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Per-user read state only - any logged-in user can read/write their own,
// no section permission needed since this doesn't expose anything beyond
// what the client already computed to build the alert list in the first
// place (see public/js/notifications.js for the notif_key scheme).
router.use(requireAuth);

router.get('/reads', (req, res) => {
  const rows = db.prepare('SELECT notif_key FROM notification_reads WHERE user_id = ?').all(req.session.user.id);
  res.json({ keys: rows.map(r => r.notif_key) });
});

router.post('/reads', (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  if (!keys.length) return res.status(400).json({ error: 'No keys provided' });
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (user_id, notif_key) VALUES (?, ?)');
  const insertMany = db.transaction((ks) => { ks.forEach(k => insert.run(req.session.user.id, k)); });
  insertMany(keys);
  res.json({ ok: true });
});

module.exports = router;
