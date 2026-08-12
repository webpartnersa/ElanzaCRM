const { db } = require('../db');

// Compares an order's worksheet_extract_* against its po_extract_* fields
// (see db.js) and rewrites order_doc_flags with whatever's currently
// mismatched - called after every worksheet/PO upload or apply, so a flag
// always reflects the current pair of documents rather than accumulating
// stale history. Only actually compares once BOTH sides are on file; if
// only one document exists yet, any old flags are just cleared.
function compareOrderDocs(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  db.prepare('DELETE FROM order_doc_flags WHERE order_id = ?').run(orderId);
  if (!order) return;

  const hasWorksheet = order.worksheet_extract_units || order.worksheet_extract_price || order.worksheet_extract_dc_date;
  const hasPo = order.po_extract_units || order.po_extract_price || order.po_extract_dc_date;
  if (!hasWorksheet || !hasPo) return;

  const parts = [];
  if (order.worksheet_extract_units && order.po_extract_units
      && Number(order.worksheet_extract_units) !== Number(order.po_extract_units)) {
    parts.push(`units (worksheet: ${order.worksheet_extract_units}, PO: ${order.po_extract_units})`);
  }
  if (order.worksheet_extract_price && order.po_extract_price
      && Number(order.worksheet_extract_price).toFixed(2) !== Number(order.po_extract_price).toFixed(2)) {
    parts.push(`unit price (worksheet: R${Number(order.worksheet_extract_price).toFixed(2)}, PO: R${Number(order.po_extract_price).toFixed(2)})`);
  }
  if (order.worksheet_extract_dc_date && order.po_extract_dc_date
      && order.worksheet_extract_dc_date !== order.po_extract_dc_date) {
    parts.push(`delivery date (worksheet: ${order.worksheet_extract_dc_date}, PO: ${order.po_extract_dc_date})`);
  }

  if (parts.length) {
    const message = `${order.style_no || 'This order'}'s worksheet and PO disagree on ${parts.join('; ')} - worth flagging back to the retailer.`;
    db.prepare('INSERT INTO order_doc_flags (order_id, message) VALUES (?, ?)').run(orderId, message);
  }
}

module.exports = { compareOrderDocs };
