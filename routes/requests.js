const express = require('express');
const fs = require('fs');
const path = require('path');
const { db } = require('../db');
const { requireAuth, hasPermission } = require('../middleware/auth');
const { sendMail, isConfigured: mailIsConfigured, resolveSender, parseRecipients } = require('../lib/mailer');
const { buildReminderEmailHtml, buildReminderPlainText } = require('../lib/conceptGenericRequestEmailHtml');

const router = express.Router();

// A record of every factory request sent from either a concept (cost/
// quotation, sample, PP sample, bulk sample, fabric test) or a style
// (sample, PP sample, bulk sample, fabric test - no cost, see
// routes/styles.js) - see request_type. concept_id/concept_no/
// concept_description are set for the former, style_id/style_no/
// style_description for the latter, never both - routes/concepts.js's and
// routes/styles.js's send-request routes are the only writers. Gated by
// 'concepts' OR 'styles' permission (not a separate one of its own), since
// a row only ever came from one of those two sections and either
// permission is enough to see this cross-section list.
function requireConceptsOrStyles(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (!hasPermission(req.session.user, 'concepts') && !hasPermission(req.session.user, 'styles')) {
    return res.status(403).json({ error: 'Not authorized for this section' });
  }
  next();
}
router.use(requireAuth, requireConceptsOrStyles);

function blockBuyer(req, res, next) {
  if (req.session.user.role === 'buyer') return res.status(403).json({ error: 'Not authorized' });
  next();
}
router.use(blockBuyer);

const LIST_FIELDS = 'id, concept_id, concept_no, concept_description, style_id, style_no, style_description, request_type, message, sent_to, sent_by_name, subject, resend_id, status, received_at, reminder_count, last_reminder_at, created_at';

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT ${LIST_FIELDS} FROM concept_requests ORDER BY created_at DESC`).all();
  res.json({ requests: rows });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const reminders = db.prepare('SELECT * FROM request_reminders WHERE request_id = ? ORDER BY created_at ASC').all(row.id);
  res.json({ request: { ...row, reminders } });
});

// Flips a request between "still waiting on the factory" and "reply's back
// in" - the whole point of this table existing (see db.js's comment on it).
// received_at is stamped the moment it flips to received, and cleared if
// flipped back to awaiting (e.g. marked received by mistake), so it never
// shows a stale "received on" date for a request that's actually still open.
const VALID_STATUSES = ['awaiting', 'received'];
router.put('/:id/status', (req, res) => {
  const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const status = req.body && req.body.status;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare('UPDATE concept_requests SET status = ?, received_at = ? WHERE id = ?')
    .run(status, status === 'received' ? new Date().toISOString() : null, row.id);

  const updated = db.prepare(`SELECT ${LIST_FIELDS} FROM concept_requests WHERE id = ?`).get(row.id);
  res.json({ request: updated });
});

// Manual "still waiting on this" nudge - a short fixed-template bilingual
// follow-up referencing the original subject/date, sent from the same
// address the original request would resolve to for whoever clicks the
// button now (not necessarily the original sender - anyone on the team
// picking this up can chase it). Only makes sense for a request that's
// still awaiting a reply, but isn't blocked server-side beyond that (a
// reminder on an already-received request is harmless, just pointless).
router.post('/:id/remind', async (req, res) => {
  const user = req.session.user;
  if (!mailIsConfigured()) return res.status(500).json({ error: 'Email sending is not configured on the server' });
  const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  try {
    let logoDataUrl = null;
    const logoPath = path.join(__dirname, '..', 'public', 'img', 'main-LOGO-transparent.PNG');
    if (fs.existsSync(logoPath)) {
      logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
    }
    const concept = row.concept_id
      ? { concept_no: row.concept_no, description: row.concept_description }
      : { concept_no: row.style_no, description: row.style_description };
    const originalDate = new Date(row.created_at).toLocaleDateString();
    const html = buildReminderEmailHtml({ concept, requestType: row.request_type, originalSubject: row.subject, originalDate, logoDataUrl });
    const text = buildReminderPlainText({ concept, requestType: row.request_type, originalSubject: row.subject, originalDate });
    const subject = `Reminder: ${row.subject}`;

    const { from, replyTo } = resolveSender(user);
    // sent_to is stored comma-joined for a readable history (see the
    // send-request routes) - Resend wants a real array for multiple
    // recipients, not one comma-joined string, so it's split back out here.
    await sendMail({ to: parseRecipients(row.sent_to), subject, html, text, from, replyTo });

    const now = new Date().toISOString();
    db.prepare('UPDATE concept_requests SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?')
      .run(now, row.id);
    db.prepare('INSERT INTO request_reminders (request_id, sent_by_name, created_at) VALUES (?,?,?)')
      .run(row.id, user.name || '', now);

    const updated = db.prepare(`SELECT ${LIST_FIELDS} FROM concept_requests WHERE id = ?`).get(row.id);
    const reminders = db.prepare('SELECT * FROM request_reminders WHERE request_id = ? ORDER BY created_at ASC').all(row.id);
    res.json({ request: { ...updated, reminders } });
  } catch (e) {
    console.error('Reminder send failed:', e.message);
    res.status(500).json({ error: 'Failed to send reminder: ' + e.message });
  }
});

module.exports = router;
