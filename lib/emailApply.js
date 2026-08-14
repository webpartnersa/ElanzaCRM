// Phase 5 of the inbound email inbox: the actual write logic behind
// "Apply"/"Decline"/resolving a match, shared by every interface that
// drives it (the future real Review Inbox UI, and the MCP voice tools -
// see routes/mcp.js's inbound-email tools) so there's exactly one place
// that ever writes a proposed field change into concepts/styles/orders.
// Per the original brief: reuse real fields, never duplicate write logic
// out to a parallel table, and a decline marks the row declined rather
// than deleting it.
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { FIELD_DEFS, extractFieldChanges } = require('./emailExtract');

// Matches routes/inboundEmail.js's own safeSegment/PRIVATE_DIR exactly -
// duplicated rather than imported since routes/ depends on lib/, not the
// other way around, and this is a one-line sanitizer.
const PRIVATE_DIR = path.join(__dirname, '..', 'private', 'inbound-emails');
function safeSegment(v, fallback) {
  const s = (v || fallback || '').toString().trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return s || fallback;
}

// Explicit product decision (confirmed with the user, who was shown the
// tradeoff): once every proposed change on a matched email has been
// resolved (applied or declined - none left pending), the email is deleted
// outright, not archived. There is deliberately no "confirmed in writing"
// audit trail kept after that point - once acted on, it's gone, same as
// clearing a real inbox. Only fires from a human/voice-triggered apply or
// decline (see the four functions below), never from the background
// matching/extraction sweeps, so a freshly matched email with extraction
// still pending can never be mistaken for "nothing to do" and deleted
// before a proposal even exists.
function cleanupIfFullyResolved(inboundEmailId) {
  const pending = db.prepare(`SELECT COUNT(*) c FROM inbound_email_field_changes WHERE inbound_email_id = ? AND status = 'pending'`).get(inboundEmailId).c;
  if (pending > 0) return false;
  const total = db.prepare(`SELECT COUNT(*) c FROM inbound_email_field_changes WHERE inbound_email_id = ?`).get(inboundEmailId).c;
  if (total === 0) return false; // nothing was ever proposed - not "fully applied", leave it for a human to look at

  const email = db.prepare('SELECT resend_email_id FROM inbound_emails WHERE id = ?').get(inboundEmailId);
  db.prepare('DELETE FROM inbound_email_field_changes WHERE inbound_email_id = ?').run(inboundEmailId);
  db.prepare('DELETE FROM inbound_emails WHERE id = ?').run(inboundEmailId);
  if (email) {
    const dir = path.join(PRIVATE_DIR, safeSegment(email.resend_email_id));
    fs.rm(dir, { recursive: true, force: true }, () => {}); // best-effort, async - the DB rows are the source of truth, not this
  }
  return true;
}

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
  const email_deleted = cleanupIfFullyResolved(change.inbound_email_id);
  return { ...change, status: 'applied', email_deleted };
}

function declineChange(changeId) {
  const change = getChange(changeId);
  if (!change) throw new Error(`No proposed change found with id ${changeId}`);
  if (change.status !== 'pending') throw new Error(`This change is already ${change.status}, not pending`);
  db.prepare(`UPDATE inbound_email_field_changes SET status = 'declined' WHERE id = ?`).run(changeId);
  const email_deleted = cleanupIfFullyResolved(change.inbound_email_id);
  return { ...change, status: 'declined', email_deleted };
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
  const results = pending.map(change => {
    try {
      writeFieldValue(change);
      db.prepare(`UPDATE inbound_email_field_changes SET status = 'applied' WHERE id = ?`).run(change.id);
      return { id: change.id, field_name: change.field_name, ok: true };
    } catch (e) {
      return { id: change.id, field_name: change.field_name, ok: false, error: e.message };
    }
  });
  const email_deleted = cleanupIfFullyResolved(inboundEmailId);
  return { results, email_deleted };
}

function declineAllPending(inboundEmailId) {
  const pending = getPendingChanges(inboundEmailId);
  const ids = pending.map(c => c.id);
  if (ids.length) {
    db.prepare(`UPDATE inbound_email_field_changes SET status = 'declined' WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  const results = pending.map(c => ({ id: c.id, field_name: c.field_name, ok: true }));
  const email_deleted = cleanupIfFullyResolved(inboundEmailId);
  return { results, email_deleted };
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
