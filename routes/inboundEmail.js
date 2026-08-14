const express = require('express');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { Webhook } = require('svix');
const { db } = require('../db');
const { fetchReceivedEmail, fetchAttachmentMeta, downloadAttachmentBytes } = require('../lib/resendInbound');
const { classifyAndMatch } = require('../lib/emailMatch');
const { extractFieldChanges } = require('../lib/emailExtract');

const router = express.Router();
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

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

    // Phase 2 (classification + matching) runs right after a successful
    // fetch - staged separately from fetchAndStore's own try/catch so a
    // classification failure (e.g. an OpenAI blip) doesn't get reported as
    // a fetch failure or trigger the fetch retry sweep for something that
    // already succeeded; classifySweep below covers this case instead.
    try {
      const result = await classifyAndMatch(resendEmailId, openaiClient);
      if (result) console.log(`Inbound email ${resendEmailId} classified: match=${result.status}${result.type ? ` (${result.type} #${result.id})` : ''}`);

      // Phase 3 (extraction) only makes sense once there's a single
      // confident match - 'multiple'/'unmatched' emails have nothing to
      // diff proposed values against yet, so they wait for a human to
      // resolve the match first (Phase 4).
      if (result && result.status === 'matched') {
        const changes = await extractFieldChanges(resendEmailId, openaiClient);
        console.log(`Inbound email ${resendEmailId} extracted ${changes.length} proposed field change(s)`);
      }
    } catch (e) {
      console.error(`Inbound email ${resendEmailId} classification/extraction failed:`, e.message);
    }
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

// Same sweep pattern as retrySweep, for the classification step instead of
// the fetch step - a row can be fully fetched but never classified if the
// process restarted between the two, or the OpenAI call itself failed.
function classifySweep() {
  const stuck = db.prepare(`
    SELECT resend_email_id FROM inbound_emails
    WHERE fetch_status = 'fetched' AND classified_at IS NULL
    ORDER BY created_at ASC LIMIT 20
  `).all();
  if (!stuck.length) return;
  console.log(`Inbound classify sweep: classifying ${stuck.length} email(s)`);
  stuck.reduce((chain, row) => chain.then(() => classifyAndMatch(row.resend_email_id, openaiClient)), Promise.resolve())
    .catch(e => console.error('Inbound classify sweep error:', e.message));
}
setInterval(classifySweep, RETRY_SWEEP_INTERVAL_MS);

// Same pattern again for extraction - catches a matched, classified row
// that never got its Phase 3 pass (process restart, or a match that
// resolved from 'multiple'/'unmatched' to 'matched' after a human picked a
// record in the future Review Inbox UI, which needs extraction run for the
// first time at that point too).
function extractSweep() {
  const stuck = db.prepare(`
    SELECT resend_email_id FROM inbound_emails
    WHERE fetch_status = 'fetched' AND match_status = 'matched' AND extracted_at IS NULL
    ORDER BY created_at ASC LIMIT 20
  `).all();
  if (!stuck.length) return;
  console.log(`Inbound extract sweep: extracting ${stuck.length} email(s)`);
  stuck.reduce((chain, row) => chain.then(() => extractFieldChanges(row.resend_email_id, openaiClient)), Promise.resolve())
    .catch(e => console.error('Inbound extract sweep error:', e.message));
}
setInterval(extractSweep, RETRY_SWEEP_INTERVAL_MS);

module.exports = router;
