const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission } = require('../middleware/auth');

const router = express.Router();

// Section-level gate: can this user reach Shipping at all. Independent of
// role - see db.js's users.permissions column comment.
router.use(requireAuth, requirePermission('shipping'));

// Buyers are read-mostly everywhere else in the app (Styles, Concepts) and
// stay that way here too, even once granted the 'shipping' permission -
// permission controls whether the section is reachable, not whether they
// can edit it. Applied to every mutation route below.
function blockBuyerWrite(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}

// Cost/margin/invoicing fields are stripped for buyers even with section
// access - same principle as Styles' cost fields and Concepts'
// cost_estimate: real money figures aren't for buyer eyes, only logistics
// status (dates, quantities, production milestones, RSP - buyers already
// see target_rsp on Styles, so it's not treated as sensitive here either).
const BUYER_VISIBLE_ORDER_FIELDS = [
  'id', 'container_id', 'style_id', 'style_no', 'description', 'cbm', 'order_no',
  'po_delivery_date', 'ck_po_date', 'units', 'rsp', 'bailed', 'season', 'colour',
  'container_code', 'fabric_code', 'dc_status', 'created_at', 'delays', 'delay_count', 'cad_photo_path',
  'rms_article_no', 'import_code', 'composition',
  'sent_to_factory', 'cads', 'labdip', 'fabric_test', 'fabric_test_start',
  'fabric_approved', 'fabric_sent_to_buyer', 'fit', 'preprod', 'preship',
  'po_cartons', 'true_cbm', 'true_cartons', 'units_shipped',
  'warehouse_packing_list', 'actual_dc'
];
function scopeOrderForRole(order, user) {
  if (user.role !== 'buyer') return order;
  const scoped = {};
  BUYER_VISIBLE_ORDER_FIELDS.forEach(f => { scoped[f] = order[f]; });
  return scoped;
}

const ORDER_FIELDS = [
  'style_no', 'description', 'cbm', 'order_no', 'po_delivery_date', 'ck_po_date',
  'units', 'rsp', 'bailed', 'season', 'colour', 'container_code', 'fabric_code', 'dc_status',
  'sent_to_factory', 'labdip', 'fabric_test', 'fit', 'preprod', 'preship',
  'po_price', 'rand_excl', 'roe', 'landed', 'profit', 'margin',
  'supp_inv', 'supp_inv_date', 'actual_dc', 'payment_due', 'invoice_value', 'elanza_paid',
  // Full ORDER SCHEDULE field parity (see db.js for the sheet-column mapping)
  'rms_article_no', 'import_code', 'cads', 'composition',
  'fabric_test_start', 'fabric_approved', 'fabric_sent_to_buyer', 'po_cartons',
  'rand_incl', 'est_lp', 'k_lp', 'factor', 'profit_per_item',
  'total_rand_excl', 'total_rand_incl', 'total_dollar_value',
  'cents', 'pct', 'true_dollar_price', 'true_cbm', 'true_cartons', 'finv',
  'units_shipped', 'true_dollar_total', 'warehouse_packing_list', 'warehouse_work_done',
  'payment_terms', 'pop_received_date', 'invoice_value_excl', 'discount_terms',
  'addendum_discounts', 'landed_roe', 'liverpool_payment_date', 'elanza_inv', 'elanza_ttl_inv_paid'
];

// Attaches this order's full delay history (oldest first) plus a count -
// the count is what drives the escalation badge in the grid ("4th" = the
// shipment date has been pushed out 4 times, an urgent one to discuss).
const getDelays = db.prepare('SELECT * FROM order_delays WHERE order_id = ? ORDER BY created_at ASC');
function attachDelays(order) {
  order.delays = getDelays.all(order.id);
  order.delay_count = order.delays.length;
  return order;
}

// An order arrives here automatically once its originating style reaches
// PO Confirmed (routes/styles.js), carrying that style's id along with it -
// this looks up the CAD image already on record for that style (uploaded/
// generated from the Style drawer's CAD tab) so the order drawer can show
// it too, without duplicating or re-uploading anything. Orders with no
// style_id (manually created, e.g. from an imported sheet) just get null.
const getCadPhoto = db.prepare("SELECT path FROM photos WHERE style_id = ? AND role = 'cad' LIMIT 1");
function attachCadPhoto(order) {
  order.cad_photo_path = order.style_id ? (getCadPhoto.get(order.style_id) || {}).path || null : null;
  return order;
}

// ---- List: active (non-delivered) containers with their orders, plus the
// unassigned pool (container_id IS NULL) - the frontend assembles the
// "Unassigned Orders" pseudo-group from the latter, same shape as the demo. ----
router.get('/', (req, res) => {
  const user = req.session.user;
  const containers = db.prepare('SELECT * FROM containers WHERE delivered = 0 ORDER BY created_at ASC').all();
  const getOrders = db.prepare('SELECT * FROM orders WHERE container_id = ? ORDER BY sort_order ASC, id ASC');
  containers.forEach(c => { c.orders = getOrders.all(c.id).map(o => scopeOrderForRole(attachCadPhoto(attachDelays(o)), user)); });
  const unassigned = db.prepare('SELECT * FROM orders WHERE container_id IS NULL ORDER BY sort_order ASC, id ASC').all()
    .map(o => scopeOrderForRole(attachCadPhoto(attachDelays(o)), user));
  res.json({ containers, unassigned });
});

// ---- Containers ----
// Sequential factory-facing code (CK1, CK2, CK3...) - assigned once at
// creation, never edited afterward, same auto-numbering pattern as
// nextConceptNo/nextStyleNo elsewhere in the app.
function nextContainerCode() {
  const rows = db.prepare("SELECT code FROM containers WHERE code LIKE 'CK%'").all();
  let max = 0;
  rows.forEach(r => {
    const n = parseInt(String(r.code).replace('CK', ''), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return 'CK' + (max + 1);
}

router.post('/containers', blockBuyerWrite, (req, res) => {
  const { vessel, container_type } = req.body || {};
  const code = nextContainerCode();
  // container_no is the free-text "name" (a real physical container number
  // like RTGVFDS345345 once known) - defaults to the code so it's never
  // blank, but is fully renameable afterward without touching the code.
  const info = db.prepare('INSERT INTO containers (container_no, vessel, container_type, notes, code) VALUES (?,?,?,?,?)')
    .run(code, (vessel || 'TBA').trim(), container_type || '40FT HQ', '', code);
  const created = db.prepare('SELECT * FROM containers WHERE id = ?').get(info.lastInsertRowid);
  created.orders = [];
  res.json({ container: created });
});

router.put('/containers/:id', blockBuyerWrite, (req, res) => {
  const container = db.prepare('SELECT * FROM containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ error: 'Container not found' });
  // 'code' is intentionally not editable here - it's assigned once at
  // creation and stays fixed, so it keeps working as a stable factory
  // reference even if container_no (the name) gets renamed later.
  const fields = ['container_no', 'vessel', 'container_type', 'notes', 'delivered', 'etd', 'eta', 'transit_status'];
  const updates = [];
  const values = [];
  fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE containers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM containers WHERE id = ?').get(req.params.id);
  updated.orders = db.prepare('SELECT * FROM orders WHERE container_id = ? ORDER BY sort_order ASC, id ASC').all(updated.id).map(attachDelays);
  res.json({ container: updated });
});

// For a container created by mistake - unlike markContainerDelivered's
// PUT delivered:1 (a soft hide, keeps the row for real delivered-container
// history), this actually removes the row. Any orders still sitting in it
// are dropped back into the unassigned pool (container_id = NULL) rather
// than deleted themselves - a mistaken container shouldn't take real order
// records down with it.
router.delete('/containers/:id', blockBuyerWrite, (req, res) => {
  const container = db.prepare('SELECT * FROM containers WHERE id = ?').get(req.params.id);
  if (!container) return res.status(404).json({ error: 'Container not found' });
  db.prepare('UPDATE orders SET container_id = NULL WHERE container_id = ?').run(container.id);
  db.prepare('DELETE FROM containers WHERE id = ?').run(container.id);
  res.json({ ok: true });
});

// ---- Orders ----
router.put('/orders/:id', blockBuyerWrite, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const updates = [];
  const values = [];
  ORDER_FIELDS.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); } });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  values.push(req.params.id);
  db.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  attachDelays(updated);
  res.json({ order: updated });
});

// Logs a shipment date change with a required reason and applies the new
// date in the same call - old_date is read from the order's current row
// server-side rather than trusted from the client, so the log can't be
// spoofed by a stale/edited request. First-time date entry (order currently
// has no po_delivery_date) skips this route entirely on the frontend - it's
// only called when an already-set date is being pushed out.
router.post('/orders/:id/delays', blockBuyerWrite, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { new_date, reason } = req.body || {};
  if (!new_date) return res.status(400).json({ error: 'new_date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required when the shipment date changes' });

  db.prepare('INSERT INTO order_delays (order_id, old_date, new_date, reason) VALUES (?,?,?,?)')
    .run(order.id, order.po_delivery_date || null, new_date, reason.trim());
  db.prepare('UPDATE orders SET po_delivery_date = ? WHERE id = ?').run(new_date, order.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  attachDelays(updated);
  res.json({ order: updated });
});

router.delete('/orders/:id', blockBuyerWrite, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  db.prepare('DELETE FROM order_delays WHERE order_id = ?').run(order.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(order.id);
  res.json({ ok: true });
});

// Handles both drag interactions the grid supports in one call: moving an
// order into a different container (or into the unassigned pool, when
// containerId is null) and setting the resulting order within that
// container - the frontend always computes the full target list client-side
// before calling this, same as concepts.js's photo reorder endpoint.
router.put('/move', blockBuyerWrite, (req, res) => {
  const { containerId, order } = req.body || {};
  if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: 'order array is required' });
  let containerCode = null;
  if (containerId != null) {
    const container = db.prepare('SELECT id, code FROM containers WHERE id = ?').get(containerId);
    if (!container) return res.status(404).json({ error: 'Container not found' });
    containerCode = container.code;
  }
  // Moving into a container copies its current short code onto every order
  // that lands there; moving back to the unassigned pool clears it, since
  // the order is no longer actually in that container.
  const update = db.prepare('UPDATE orders SET container_id = ?, sort_order = ?, container_code = ? WHERE id = ?');
  order.forEach((orderId, i) => update.run(containerId != null ? containerId : null, i, containerCode, orderId));
  res.json({ ok: true });
});

module.exports = router;
