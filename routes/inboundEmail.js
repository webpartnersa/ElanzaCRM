const express = require('express');
const fs = require('fs');
const path = require('path');
const { Webhook } = require('svix');
const { db } = require('../db');
const { fetchReceivedEmail, fetchAttachmentMeta, downloadAttachmentBytes } = require('../lib/resendInbound');

const router = express.Router();

// Never under public/ or /uploads - inbound mail can contain anything a
// factory or buyer sends, same "authenticated routes only" reasoning as
// worksheets/final-submission docs elsewhere in this app.
const PRIVATE_DIR = path.join(__dirname, '..', 'private', 'inbound-emails');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

function safeSegment(v, fallback) {
  const s = (v || fallback || '').toString().trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
  return s || fallback;
}

// Resend sends the webhook via Svix, which is at-least-once delivery, not
// exactly-once - a redelivery of the same event is expected/normal, not an
// error. resend_email_id is UNIQUE, so this is a safe no-op on a repeat.
function insertStubRow(data) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO inbound_emails
      (resend_email_id, from_email, from_name, to_email, cc, subject, message_id, received_at)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    data.email_id,
    data.from || null,
    null, // display name isn't in the webhook payload - filled in from the full fetch below
    Array.isArray(data.to) ? data.to.join(', ') : (data.to || null),
    Array.isArray(data.cc) ? data.cc.join(', ') : (data.cc || null),
    data.subject || null,
    data.message_id || null,
    data.created_at || null
  );
  return info.changes > 0; // false if this exact email_id was already stored (redelivery)
}

// The full fetch+attachment-download step, shared by the webhook handler
// (fired right after insertStubRow) and the retry sweep below (for rows
// where this failed the first time - a network blip talking to Resend's
// own API shouldn't mean the email is silently lost).
async function fetchAndStore(resendEmailId) {
  const row = db.prepare('SELECT * FROM inbound_emails WHERE resend_email_id = ?').get(resendEmailId);
  if (!row) return;
  try {
    const email = await fetchReceivedEmail(resendEmailId);

    const attachmentsMeta = [];
    if (Array.isArray(email.attachments) && email.attachments.length) {
      const dir = path.join(PRIVATE_DIR, safeSegment(resendEmailId, 'email-' + row.id));
      fs.mkdirSync(dir, { recursive: true });
      for (const a of email.attachments) {
        try {
          const meta = await fetchAttachmentMeta(resendEmailId, a.id);
          const bytes = await downloadAttachmentBytes(meta.download_url);
          const filename = safeSegment(meta.filename, a.id) || a.id;
          fs.writeFileSync(path.join(dir, filename), bytes);
          attachmentsMeta.push({
            id: a.id, filename: meta.filename, content_type: meta.content_type,
            size: meta.size, storage_path: path.join(safeSegment(resendEmailId, 'email-' + row.id), filename),
          });
        } catch (e) {
          // One broken attachment shouldn't lose the whole email - record
          // what we know and move on, same "don't fail the whole thing over
          // one bad file" pattern used for photo/report uploads elsewhere.
          attachmentsMeta.push({ id: a.id, filename: a.filename, error: e.message });
        }
      }
    }

    db.prepare(`
      UPDATE inbound_emails SET
        from_email = ?, from_name = ?, to_email = ?, cc = ?, subject = ?,
        message_id = ?, in_reply_to = ?, references_header = ?,
        text_body = ?, html_body = ?, headers_json = ?, attachments_json = ?,
        received_at = COALESCE(received_at, ?),
        fetch_status = 'fetched', fetch_error = NULL, fetch_attempts = fetch_attempts + 1
      WHERE resend_email_id = ?
    `).run(
      email.from || row.from_email,
      (email.headers && email.headers.from) || row.from_name,
      Array.isArray(email.to) ? email.to.join(', ') : (email.to || row.to_email),
      Array.isArray(email.cc) ? email.cc.join(', ') : (email.cc || row.cc),
      email.subject || row.subject,
      (email.headers && email.headers['message-id']) || row.message_id,
      (email.headers && email.headers['in-reply-to']) || null,
      (email.headers && email.headers['references']) || null,
      email.text || null,
      email.html || null,
      JSON.stringify(email.headers || {}),
      JSON.stringify(attachmentsMeta),
      email.created_at || null,
      resendEmailId
    );
    console.log(`Inbound email ${resendEmailId} fetched and stored (${attachmentsMeta.length} attachment(s))`);
  } catch (e) {
    db.prepare(`
      UPDATE inbound_emails SET fetch_status = 'failed', fetch_error = ?, fetch_attempts = fetch_attempts + 1
      WHERE resend_email_id = ?
    `).run(e.message, resendEmailId);
    console.error(`Inbound email ${resendEmailId} fetch failed:`, e.message);
  }
}

// Raw body (not JSON-parsed) is required for signature verification - see
// server.js, which mounts this router before the app-wide express.json()
// so nothing upstream consumes the request stream first.
router.post('/resend-webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Inbound webhook received but RESEND_WEBHOOK_SECRET is not set - rejecting rather than processing unverified mail.');
    return res.status(500).json({ error: 'Inbound webhook not configured' });
  }

  let event;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(req.body, {
      'svix-id': req.headers['svix-id'],
      'svix-timestamp': req.headers['svix-timestamp'],
      'svix-signature': req.headers['svix-signature'],
    });
  } catch (e) {
    console.error('Inbound webhook signature verification failed:', e.message);
    return res.status(401).json({ error: 'Invalid signature' });
  }

  if (event.type !== 'email.received') {
    // Other event types (delivered/bounced/etc, if this endpoint is ever
    // reused for them) are acknowledged, not treated as an error.
    return res.status(200).json({ ok: true, ignored: event.type });
  }

  const isNew = insertStubRow(event.data);
  res.status(200).json({ ok: true }); // ack immediately - the full fetch below shouldn't hold up the webhook response

  if (isNew) {
    fetchAndStore(event.data.email_id).catch(e => console.error('Inbound fetchAndStore threw:', e.message));
  }
});

// Retry sweep: catches anything the webhook's own immediate fetch attempt
// didn't finish (a network blip calling Resend's API, or this process
// restarting mid-fetch) - runs independently of whether Svix ever retries
// the original webhook delivery. Capped at 5 attempts so one permanently
// broken row (e.g. an attachment link that 404s forever) doesn't retry
// forever; still visible via fetch_status='failed' either way.
const RETRY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_FETCH_ATTEMPTS = 5;
function retrySweep() {
  const stuck = db.prepare(`
    SELECT resend_email_id FROM inbound_emails
    WHERE fetch_status IN ('pending', 'failed') AND fetch_attempts < ?
    ORDER BY created_at ASC LIMIT 20
  `).all(MAX_FETCH_ATTEMPTS);
  if (!stuck.length) return;
  console.log(`Inbound retry sweep: retrying ${stuck.length} email(s)`);
  stuck.reduce((chain, row) => chain.then(() => fetchAndStore(row.resend_email_id)), Promise.resolve())
    .catch(e => console.error('Inbound retry sweep error:', e.message));
}
setInterval(retrySweep, RETRY_SWEEP_INTERVAL_MS);

module.exports = router;
