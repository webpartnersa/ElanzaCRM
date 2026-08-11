const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { getResetCounts, performReset } = require('../lib/resetConceptsAndStyles');

const router = express.Router();

// Admin-only, same destructive action as scripts/reset-concepts-and-styles.js
// (see that file and lib/resetConceptsAndStyles.js for exact scope) - this
// is the "Danger Zone" button on Settings, so the person actually clicking
// it in their own browser is the one performing the delete, not this server
// acting on its own initiative.
router.use(requireAdmin);

router.get('/reset-preview', (req, res) => {
  res.json({ counts: getResetCounts(db) });
});

// Requires the exact phrase typed in the confirmation box, not just any
// truthy flag - makes an accidental double-click or a stray API call
// structurally incapable of triggering this.
router.post('/reset', (req, res) => {
  const { confirmPhrase } = req.body || {};
  if (confirmPhrase !== 'DELETE ALL') {
    return res.status(400).json({ error: 'Confirmation phrase did not match' });
  }
  try {
    const result = performReset(db);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('Admin reset failed:', e.message);
    res.status(500).json({ error: 'Reset failed: ' + e.message });
  }
});

module.exports = router;
