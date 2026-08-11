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
  const rows = db.prepare('SELECT notif_key, dismissed_at FROM notification_reads WHERE user_id = ?').all(req.session.user.id);
  res.json({
    keys: rows.map(r => r.notif_key),
    dismissedKeys: rows.filter(r => r.dismissed_at).map(r => r.notif_key),
  });
});

router.post('/reads', (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  if (!keys.length) return res.status(400).json({ error: 'No keys provided' });
  const insert = db.prepare('INSERT OR IGNORE INTO notification_reads (user_id, notif_key) VALUES (?, ?)');
  const insertMany = db.transaction((ks) => { ks.forEach(k => insert.run(req.session.user.id, k)); });
  insertMany(keys);
  res.json({ ok: true });
});

// "Delete" - see db.js's dismissed_at comment for why this reuses the read
// table rather than actually deleting anything. Upserts so it works
// whether or not the key already has a read_at row.
router.post('/dismiss', (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [];
  if (!keys.length) return res.status(400).json({ error: 'No keys provided' });
  const upsert = db.prepare(`
    INSERT INTO notification_reads (user_id, notif_key, dismissed_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, notif_key) DO UPDATE SET dismissed_at = CURRENT_TIMESTAMP
  `);
  const upsertMany = db.transaction((ks) => { ks.forEach(k => upsert.run(req.session.user.id, k)); });
  upsertMany(keys);
  res.json({ ok: true });
});

module.exports = router;
