// Real outbound email via Resend's HTTP API - see routes/concepts.js's
// send-costing-email route, the only caller. Chosen over raw SMTP after the
// elanzas.com mailbox's SMTP ports (465/587/25) turned out to be blocked
// outbound from this server (confirmed via direct TCP connection tests) -
// Resend just needs outbound HTTPS, which already works. Plain fetch()
// rather than the `resend` npm package - the API surface used here is one
// POST call, not worth a dependency for.
const RESEND_API_URL = 'https://api.resend.com/emails';

function isConfigured() {
  return !!(process.env.RESEND_API_KEY && process.env.RESEND_FROM);
}

// `from` defaults to RESEND_FROM but callers (see routes/concepts.js) can
// override it to show the actual sending user, and `replyTo` lets a reply
// land in that user's real inbox even when `from` couldn't be theirs (see
// resolveSender below) - Resend rejects a request outright if `from` isn't
// on the domain, so this can't be skipped or best-effort.
async function sendMail({ to, subject, html, text, from, replyTo }) {
  if (!isConfigured()) throw new Error('Email sending is not configured (RESEND_API_KEY/RESEND_FROM missing from .env)');
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: from || process.env.RESEND_FROM,
      to, subject, html, text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Resend request failed (${res.status})`);
  }
  return data; // { id: "..." }
}

// Resend only accepts a `from` address whose domain is verified with it
// (elanzas.com, via RESEND_FROM) - it isn't optional, so a user logged in
// with an address on any other domain (e.g. an admin's own work email)
// can't literally be the From: header or the send is rejected outright.
// When that's the case, this falls back to the verified address but still
// puts the user's real name on it and sets Reply-To to their actual
// address, so a factory's reply still reaches them directly even though
// the From: shows the shared mailbox.
function resolveSender(user) {
  const verifiedDomain = (process.env.RESEND_FROM || '').split('@')[1];
  const userDomain = (user.email || '').split('@')[1];
  const name = user.name || 'Elanzas';
  if (verifiedDomain && userDomain && userDomain.toLowerCase() === verifiedDomain.toLowerCase()) {
    return { from: `${name} <${user.email}>`, replyTo: undefined };
  }
  return { from: `${name} <${process.env.RESEND_FROM}>`, replyTo: user.email || undefined };
}

module.exports = { sendMail, isConfigured, resolveSender };
