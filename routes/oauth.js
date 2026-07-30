const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || 'https://portal.elanzas.com';
const ACCESS_TOKEN_TTL = 60 * 60; // 1 hour

function b64url(buf) { return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function randomToken() { return b64url(crypto.randomBytes(32)); }

// ---- Discovery metadata (how Claude finds out how to authenticate) ----
router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/oauth/authorize`,
    token_endpoint: `${BASE_URL}/oauth/token`,
    registration_endpoint: `${BASE_URL}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none']
  });
});

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({ resource: `${BASE_URL}/mcp`, authorization_servers: [BASE_URL] });
});

// ---- Dynamic client registration - Claude registers itself automatically ----
router.post('/oauth/register', (req, res) => {
  const { redirect_uris, client_name } = req.body || {};
  if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
  }
  const client_id = randomToken();
  db.prepare('INSERT INTO oauth_clients (client_id, redirect_uris, client_name) VALUES (?,?,?)')
    .run(client_id, JSON.stringify(redirect_uris), client_name || 'MCP client');
  res.status(201).json({
    client_id, redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code']
  });
});

// ---- Authorize: login (if needed) then consent screen ----
router.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
  const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
  if (!client) return res.status(400).send('Unknown client');
  const allowed = JSON.parse(client.redirect_uris);
  if (!allowed.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered for this client');
  if (response_type !== 'code') return res.status(400).send('Only response_type=code is supported');
  if (code_challenge_method !== 'S256') return res.status(400).send('Only PKCE S256 is supported');

  const qs = new URLSearchParams({ client_id, redirect_uri, state: state||'', code_challenge, code_challenge_method }).toString();
  const loggedInAdmin = req.session.user && req.session.user.role === 'admin';
  if (!loggedInAdmin) return res.send(renderAuthPage({ mode:'login', qs, error:'' }));
  res.send(renderAuthPage({ mode:'consent', qs, clientName: client.client_name, userName: req.session.user.name }));
});

router.post('/oauth/authorize/login', (req, res) => {
  const { email, password, qs } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email||'').toLowerCase().trim());
  if (!user || user.role !== 'admin' || !bcrypt.compareSync(password||'', user.password_hash)) {
    return res.send(renderAuthPage({ mode:'login', qs, error:'Invalid email/password, or this account is not an admin.' }));
  }
  req.session.user = { id:user.id, name:user.name, role:user.role, retailer:user.retailer, department:user.department };
  const params = new URLSearchParams(qs);
  const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(params.get('client_id'));
  res.send(renderAuthPage({ mode:'consent', qs, clientName: client ? client.client_name : 'MCP client', userName: user.name }));
});

router.post('/oauth/authorize/approve', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'admin') return res.status(401).send('Not logged in');
  const params = new URLSearchParams(req.body.qs || '');
  const client_id = params.get('client_id');
  const redirect_uri = params.get('redirect_uri');
  const state = params.get('state');
  const code_challenge = params.get('code_challenge');
  const code_challenge_method = params.get('code_challenge_method');

  const client = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(client_id);
  if (!client) return res.status(400).send('Unknown client');
  const allowed = JSON.parse(client.redirect_uris);
  if (!allowed.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered');

  const code = randomToken();
  const expires_at = Date.now() + 5 * 60 * 1000;
  db.prepare(`INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, user_id, expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(code, client_id, redirect_uri, code_challenge, code_challenge_method, req.session.user.id, expires_at);

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.toString());
});

function renderAuthPage({ mode, qs, error, clientName, userName }) {
  const esc = s => String(s||'').replace(/</g,'&lt;');
  const shared = `body{font-family:-apple-system,sans-serif;background:#1F3350;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
    .box{background:#fff;padding:32px;border-radius:6px;width:340px;}
    input{width:100%;padding:9px;margin-bottom:10px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;}
    button{width:100%;padding:10px;background:#2F4869;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;}
    .err{color:#a63a3a;font-size:13px;margin-bottom:10px;}`;
  if (mode === 'login') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sign in - Docket</title><style>${shared}</style></head><body>
    <div class="box"><h2>Sign in to authorize access</h2>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="POST" action="/oauth/authorize/login">
      <input type="hidden" name="qs" value="${esc(qs)}"/>
      <input type="email" name="email" placeholder="Admin email" required/>
      <input type="password" name="password" placeholder="Password" required/>
      <button type="submit">Sign in</button>
    </form></div></body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorize - Docket</title><style>${shared}</style></head><body>
  <div class="box"><h2>Allow access?</h2>
  <p><b>${esc(clientName)}</b> wants to access your Docket portal data as <b>${esc(userName)}</b>.</p>
  <form method="POST" action="/oauth/authorize/approve">
    <input type="hidden" name="qs" value="${esc(qs)}"/>
    <button type="submit">Allow</button>
  </form></div></body></html>`;
}

// ---- Token endpoint ----
router.post('/oauth/token', (req, res) => {
  const { grant_type } = req.body;

  if (grant_type === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = req.body;
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code);
    if (!row || row.used || row.expires_at < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
    if (row.client_id !== client_id || row.redirect_uri !== redirect_uri) return res.status(400).json({ error: 'invalid_grant' });
    const challenge = b64url(crypto.createHash('sha256').update(code_verifier).digest());
    if (challenge !== row.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);

    const access_token = randomToken();
    const refresh_token = randomToken();
    const expires_at = Date.now() + ACCESS_TOKEN_TTL * 1000;
    db.prepare('INSERT INTO oauth_tokens (access_token, refresh_token, client_id, user_id, expires_at) VALUES (?,?,?,?,?)')
      .run(access_token, refresh_token, client_id, row.user_id, expires_at);
    return res.json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token });
  }

  if (grant_type === 'refresh_token') {
    const { refresh_token, client_id } = req.body;
    const row = db.prepare('SELECT * FROM oauth_tokens WHERE refresh_token = ? AND client_id = ?').get(refresh_token, client_id);
    if (!row) return res.status(400).json({ error: 'invalid_grant' });
    const access_token = randomToken();
    const expires_at = Date.now() + ACCESS_TOKEN_TTL * 1000;
    db.prepare('INSERT INTO oauth_tokens (access_token, refresh_token, client_id, user_id, expires_at) VALUES (?,?,?,?,?)')
      .run(access_token, refresh_token, client_id, row.user_id, expires_at);
    return res.json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL, refresh_token });
  }

  res.status(400).json({ error: 'unsupported_grant_type' });
});

module.exports = router;