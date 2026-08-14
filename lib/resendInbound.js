// Resend Inbound - the "Receiving" and "Attachments" REST APIs, called
// after the email.received webhook fires (see routes/inboundEmail.js). The
// webhook payload itself is metadata-only (no body, no attachment
// content) - these are what actually pull the full email and download
// each attachment's bytes. Plain fetch(), same reasoning as
// lib/mailer.js's sendMail - a couple of calls, not worth an SDK
// dependency for.
const RESEND_API_BASE = 'https://api.resend.com';

function authHeaders() {
  return { Authorization: `Bearer ${process.env.RESEND_API_KEY}` };
}

// GET /emails/receiving/:id - full email: to/from/cc/bcc/reply_to, subject,
// html, text, headers (object), attachments (metadata, no content), and a
// `raw` object with its own signed download_url for the original file.
async function fetchReceivedEmail(emailId) {
  const res = await fetch(`${RESEND_API_BASE}/emails/receiving/${emailId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Resend Receiving API failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// GET /emails/receiving/:emailId/attachments/:attachmentId - one
// attachment's metadata plus a signed download_url (Resend's own CDN,
// long-lived per their docs) for the actual bytes.
async function fetchAttachmentMeta(emailId, attachmentId) {
  const res = await fetch(`${RESEND_API_BASE}/emails/receiving/${emailId}/attachments/${attachmentId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Resend Attachments API failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Downloads the actual bytes from a fetchAttachmentMeta() download_url -
// saved into this app's own private storage rather than relying on
// Resend's URL staying valid indefinitely (same "don't depend on someone
// else's host for something central to the app" reasoning as every other
// upload in this codebase).
async function downloadAttachmentBytes(downloadUrl) {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { fetchReceivedEmail, fetchAttachmentMeta, downloadAttachmentBytes };
