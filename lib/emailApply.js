// Phase 5 of the inbound email inbox: the actual write logic behind
// "Apply"/"Decline"/resolving a match, shared by every interface that
// drives it (the future real Review Inbox UI, and the MCP voice tools -
// see routes/mcp.js's inbound-email tools) so there's exactly one place
// that ever writes a proposed field change into concepts/styles/orders.
// Per the original brief: reuse real fields, never duplicate write logic
// out to a parallel table, and a decline marks the row declined rather
// than deleting it.
const { db } = require('../db');
const { FIELD_DEFS, extractFieldChanges } = require('./emailExtract');

// orders has no updated_at column (unlike concepts/styles) - see db.js's
// CREATE TABLE orders. Touching it only where it actually exists avoids a
// silent SQL error on the order path.
const TABLES_WITH_UPDATED_AT = new Set(['concepts', 'styles']);

function getChange(changeId) {
  return db.prepare(`
    SELECT fc.*, ie.match_type, ie.match_id, ie.subject
    FROM inbound_email_field_changes fc
    JOIN inbound_emails ie ON ie.id = fc.inbound_email_id
    WHERE fc.id = ?
  `).get(changeId);
}

// A PO delivery date is never a bare UPDATE elsewhere in this app (see
// routes/shipping.js's POST /orders/:id/delays and the MCP log_order_delay
// tool) - it always goes through order_delays so the delay-history/
// escalation badge stays accurate. Applying a change here follows the same
// path rather than a plain UPDATE, quoting the email as the reason.
function applyOrderDelayField(change) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(change.match_id);
  if (!order) throw new Error('The matched order no longer exists');
  const reason = `Inbound email ("${change.subject || 'no subject'}"): ${change.source_snippet || 'date change confirmed by factory/buyer'}`;
  db.prepare('INSERT INTO order_delays (order_id, old_date, new_date, reason) VALUES (?,?,?,?)')
    .run(order.id, order.po_delivery_date || null, change.proposed_value, reason);
  db.prepare('UPDATE orders SET po_delivery_date = ? WHERE id = ?').run(change.proposed_value, order.id);
}

function writeFieldValue(change) {
  const def = FIELD_DEFS[change.match_type];
  if (!def || !def.fields[change.field_name]) {
    throw new Error(`"${change.field_name}" isn't a recognized field for a ${change.match_type}`);
  }
  if (change.match_type === 'order' && change.field_name === 'po_delivery_date') {
    applyOrderDelayField(change);
    return;
  }
  const setClause = TABLES_WITH_UPDATED_AT.has(def.table)
    ? `${change.field_name} = ?, updated_at = CURRENT_TIMESTAMP`
    : `${change.field_name} = ?`;
  const info = db.prepare(`UPDATE ${def.table} SET ${setClause} WHERE id = ?`).run(change.proposed_value, change.match_id);
  if (info.changes === 0) throw new Error(`The matched ${change.match_type} no longer exists`);
}

// Applies one pending proposed change - writes the real field, then marks
// the row applied. Throws (rather than silently no-op'ing) on anything
// already applied/declined, a stale match, or an unrecognized field, so
// callers (both the web route and the MCP tool) can surface a clear error
// instead of a false "done".
function applyChange(changeId) {
  const change = getChange(changeId);
  if (!change) throw new Error(`No proposed change found with id ${changeId}`);
  if (change.status !== 'pending') throw new Error(`This change is already ${change.status}, not pending`);
  writeFieldValue(change);
  db.prepare(`UPDATE inbound_email_field_changes SET status = 'applied' WHERE id = ?`).run(changeId);
  return { ...change, status: 'applied' };
}

function declineChange(changeId) {
  const change = getChange(changeId);
  if (!change) throw new Error(`No proposed change found with id ${changeId}`);
  if (change.status !== 'pending') throw new Error(`This change is already ${change.status}, not pending`);
  db.prepare(`UPDATE inbound_email_field_changes SET status = 'declined' WHERE id = ?`).run(changeId);
  return { ...change, status: 'declined' };
}

function getPendingChanges(inboundEmailId) {
  return db.prepare(`
    SELECT fc.*, ie.match_type, ie.match_id, ie.subject
    FROM inbound_email_field_changes fc
    JOIN inbound_emails ie ON ie.id = fc.inbound_email_id
    WHERE fc.inbound_email_id = ? AND fc.status = 'pending'
  `).all(inboundEmailId);
}

// Applies every still-pending change for one email. Not wrapped in a single
// DB transaction - one field failing (e.g. a stale match) shouldn't roll
// back sibling fields that applied cleanly; each result records its own
// outcome instead.
function applyAllPending(inboundEmailId) {
  const pending = getPendingChanges(inboundEmailId);
  return pending.map(change => {
    try {
      writeFieldValue(change);
      db.prepare(`UPDATE inbound_email_field_changes SET status = 'applied' WHERE id = ?`).run(change.id);
      return { id: change.id, field_name: change.field_name, ok: true };
    } catch (e) {
      return { id: change.id, field_name: change.field_name, ok: false, error: e.message };
    }
  });
}

function declineAllPending(inboundEmailId) {
  const pending = getPendingChanges(inboundEmailId);
  const ids = pending.map(c => c.id);
  if (ids.length) {
    db.prepare(`UPDATE inbound_email_field_changes SET status = 'declined' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return pending.map(c => ({ id: c.id, field_name: c.field_name, ok: true }));
}

function recordLabel(matchType, matchId) {
  const table = { concept: 'concepts', style: 'styles', order: 'orders' }[matchType];
  if (!table) return null;
  const noCol = matchType === 'order' ? 'order_no' : matchType === 'style' ? 'style_no' : 'concept_no';
  return db.prepare(`SELECT id, ${noCol} AS no, description FROM ${table} WHERE id = ?`).get(matchId);
}

// Resolves an email's match - used both for a human/voice pick among
// 'multiple' candidates and for linking an 'unmatched' email manually
// (same operation either way: a person is asserting which real record this
// email is about). Immediately runs Phase 3 extraction against the newly
// confirmed record, since a freshly resolved match has no proposed changes
// staged yet - matching what the Phase 4 mock simulated.
async function resolveMatch(inboundEmailId, matchType, matchId, openaiClient) {
  if (!FIELD_DEFS[matchType]) throw new Error(`matchType must be one of: ${Object.keys(FIELD_DEFS).join(', ')}`);
  const record = recordLabel(matchType, matchId);
  if (!record) throw new Error(`No ${matchType} found with id ${matchId}`);

  const email = db.prepare('SELECT * FROM inbound_emails WHERE id = ?').get(inboundEmailId);
  if (!email) throw new Error(`No inbound email found with id ${inboundEmailId}`);

  db.prepare(`
    UPDATE inbound_emails SET match_status = 'matched', match_type = ?, match_id = ?, match_confidence = 1
    WHERE id = ?
  `).run(matchType, matchId, inboundEmailId);

  const changes = await extractFieldChanges(email.resend_email_id, openaiClient);
  return { record, changes };
}

module.exports = { applyChange, declineChange, applyAllPending, declineAllPending, resolveMatch, recordLabel, getChange };
