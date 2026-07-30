const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Admin-only, full stop - not the per-user section-permission system used
// elsewhere (styles/concepts/shipping/contacts/fabrics). Financial figures
// don't get a middle ground here.
router.use(requireAdmin);

// Every order ever created, active or from a delivered/removed container -
// a P&L needs realized history, not just what's currently on the board.
// Client computes profit/margin/forecasts from these raw fields (same
// lean-backend pattern as /api/shipping) so the formula lives in one place
// (public/js/finance.js) instead of being duplicated server + client side.
router.get('/', (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, s.retailer AS style_retailer, s.department AS style_department
    FROM orders o
    LEFT JOIN styles s ON s.id = o.style_id
    ORDER BY o.id ASC
  `).all();
  const containers = db.prepare('SELECT * FROM containers ORDER BY created_at ASC').all();
  res.json({ orders, containers });
});

module.exports = router;
