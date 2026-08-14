// The real (non-demo) Review Inbox - human-facing REST API over the same
// lib/emailApply.js / lib/emailExtract.js backend the MCP inbound-email
// tools use (routes/mcp.js), so Apply/Decline/Dismiss behave identically
// whether triggered by voice or by clicking a button here. Mounted after
// express.json()/session (see server.js), unlike routes/inboundEmail.js's
// webhook which needs the raw body and runs before both.
const express = require('express');
const OpenAI = require('openai');
const { db } = require('../db');
const { hasPermission } = require('../middleware/auth');
const {
  applyChange, declineChange, applyAllPending, declineAllPending,
  resolveMatch, recordLabel, getLinkedRecords, dismissEmail,
} = require('../lib/emailApply');

const router = express.Router();
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Inbound mail can relate to a concept, style, or order, so this is
// reachable with access to any one of those sections - same anySection
// convention as the equivalent MCP tools. Blocked outright for buyers
// (not just writes) since inbound mail can carry costing/factory detail,
// matching every inbound-email MCP tool's blockBuyer:true.
function requireInboxAccess(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  const u = req.session.user;
  if (u.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  if (!['concepts', 'styles', 'shipping'].some(s => hasPermission(u, s))) return res.status(403).json({ error: 'Not authorized for this section' });
  next();
}
router.use(requireInboxAccess);

function linkedRecordsWithChanges(inboundEmailId, includeChanges) {
  return getLinkedRecords(inboundEmailId).map(r => {
    const record = recordLabel(r.match_type, r.match_id);
    const out = { type: r.match_type, id: r.match_id, no: record ? record.no : null, description: record ? record.description : null };
    if (includeChanges) {
      out.changes = db.prepare(`
        SELECT id, field_name, field_label, current_value, proposed_value, source_snippet, status
        FROM inbound_email_field_changes WHERE inbound_email_id = ? AND match_type = ? AND match_id = ? ORDER BY id ASC
      `).all(inboundEmailId, r.match_type, r.match_id);
    }
    return out;
  });
}
function unlinkedCandidates(row) {
  if (!row.match_candidates_json) return [];
  let candidates;
  try { candidates = JSON.parse(row.match_candidates_json); } catch (e) { return []; }
  if (!Array.isArray(candidates)) return [];
  const linked = getLinkedRecords(row.id);
  return candidates.filter(c => !linked.some(l => l.match_type === c.type && l.match_id === c.id));
}

router.get('/emails', (req, res) => {
  let rows = db.prepare(`SELECT * FROM inbound_emails WHERE fetch_status = 'fetched' ORDER BY created_at DESC`).all();
  if (req.query.status) rows = rows.filter(r => r.match_status === req.query.status);
  const summary = rows.map(row => ({
    id: row.id, from_email: row.from_email, from_name: row.from_name, subject: row.subject, received_at: row.received_at,
    match_status: row.match_status,
    linked_records: linkedRecordsWithChanges(row.id, false),
    pending_changes: db.prepare(`SELECT COUNT(*) c FROM inbound_email_field_changes WHERE inbound_email_id = ? AND status = 'pending'`).get(row.id).c,
  }));
  res.json({ emails: summary });
});

router.get('/emails/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM inbound_emails WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Email not found' });
  res.json({
    id: row.id, from_email: row.from_email, from_name: row.from_name, subject: row.subject, received_at: row.received_at,
    body: row.text_body,
    match_status: row.match_status,
    linked_records: linkedRecordsWithChanges(row.id, true),
    unlinked_candidates: unlinkedCandidates(row),
  });
});

router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const needle = `%${q}%`;
  const results = [
    ...db.prepare(`SELECT id, concept_no AS no, description FROM concepts WHERE concept_no LIKE ? OR description LIKE ? LIMIT 8`).all(needle, needle).map(r => ({ type: 'concept', ...r })),
    ...db.prepare(`SELECT id, style_no AS no, description FROM styles WHERE style_no LIKE ? OR description LIKE ? LIMIT 8`).all(needle, needle).map(r => ({ type: 'style', ...r })),
    ...db.prepare(`SELECT id, order_no AS no, description FROM orders WHERE order_no LIKE ? OR style_no LIKE ? OR description LIKE ? LIMIT 8`).all(needle, needle, needle).map(r => ({ type: 'order', ...r })),
  ].slice(0, 15);
  res.json({ results });
});

router.post('/emails/:id/resolve', async (req, res) => {
  const { record_type, record_id } = req.body || {};
  if (!['concept', 'style', 'order'].includes(record_type) || !record_id) {
    return res.status(400).json({ error: 'record_type and record_id are required' });
  }
  try {
    const { record, changes } = await resolveMatch(Number(req.params.id), record_type, Number(record_id), openaiClient);
    res.json({ record, changes });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/emails/:id/dismiss', (req, res) => {
  try {
    dismissEmail(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/emails/:id/apply-all', (req, res) => {
  const { record_type, record_id } = req.body || {};
  const record = record_type && record_id ? { matchType: record_type, matchId: Number(record_id) } : undefined;
  const { results, email_deleted } = applyAllPending(Number(req.params.id), record);
  res.json({ results, email_deleted });
});

router.post('/emails/:id/decline-all', (req, res) => {
  const { record_type, record_id } = req.body || {};
  const record = record_type && record_id ? { matchType: record_type, matchId: Number(record_id) } : undefined;
  const { results, email_deleted } = declineAllPending(Number(req.params.id), record);
  res.json({ results, email_deleted });
});

router.post('/field-changes/:changeId/apply', (req, res) => {
  try {
    const change = applyChange(Number(req.params.changeId));
    res.json({ change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/field-changes/:changeId/decline', (req, res) => {
  try {
    const change = declineChange(Number(req.params.changeId));
    res.json({ change });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
