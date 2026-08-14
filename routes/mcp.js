const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const OpenAI = require('openai');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { db } = require('../db');
const { hasPermission } = require('../middleware/auth');
const { scopeStyleForRole } = require('../lib/scope');
const { translateConceptFields, translateMessage, REQUEST_TYPES } = require('../lib/conceptCostingTranslate');
const { buildCostingEmailHtml, buildCostingPlainText } = require('../lib/conceptCostingEmailHtml');
const { buildGenericRequestEmailHtml, buildGenericRequestPlainText, buildReminderEmailHtml, buildReminderPlainText } = require('../lib/conceptGenericRequestEmailHtml');
const { sendMail, isConfigured: mailIsConfigured, resolveSender } = require('../lib/mailer');
const { imageFileToEmailDataUrl } = require('../lib/imageConvert');
const { applyChange: applyEmailChange, declineChange: declineEmailChange, applyAllPending: applyAllEmailChanges, declineAllPending: declineAllEmailChanges, resolveMatch: resolveEmailMatch, recordLabel: emailRecordLabel } = require('../lib/emailApply');

const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ---- PIN-based identity for voice/chat callers ----
// A bare MCP_TOKEN/OAuth connection (see requireMcpAuth below) only proves
// "this is a legitimate Elanza CRM connector call" - it isn't tied to any
// particular person, and voice can't complete the app's normal session
// login to become one. identify_user_by_pin is the one tool callable without
// a session: give it a PIN (set under Settings > Users) and it hands back a
// session_token, which every other tool then requires - so a call is only
// ever executed "as" a specific verified person, with that person's own
// role/section access applied (see requireSession below), never anonymously.
// Claude Voice transcribes spoken digits as words ("one two three four"),
// not numerals ("1234") - a correctly-spoken PIN would otherwise never match
// the stored numeral hash. Passes numeral input straight through unchanged.
const SPOKEN_DIGITS = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
function normalizePin(raw) {
  const trimmed = String(raw || '').trim();
  if (/^\d{4,6}$/.test(trimmed)) return trimmed;
  const digits = trimmed.toLowerCase().split(/[\s,\-]+/).filter(Boolean).map(w => SPOKEN_DIGITS[w]).join('');
  return digits;
}
function findUserByPin(pin) {
  const normalized = normalizePin(pin);
  if (!normalized || !/^\d{4,6}$/.test(normalized)) return null;
  const users = db.prepare('SELECT * FROM users WHERE pin_hash IS NOT NULL').all();
  return users.find(u => bcrypt.compareSync(normalized, u.pin_hash)) || null;
}
const PIN_SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours - long enough for one voice/chat session, short enough that a leaked token doesn't stay live
function createPinSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + PIN_SESSION_TTL_MS;
  db.prepare('INSERT INTO mcp_pin_sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}
function resolveSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM mcp_pin_sessions WHERE token = ?').get(token);
  if (!row || row.expires_at < Date.now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  return user ? { user } : null;
}
// Every tool but identify_user_by_pin calls this first. `section` checks the
// same permissions column requirePermission() gates the real app routes
// with; `blockBuyer` mirrors the app's own blockBuyerWrite - buyers are
// read-mostly everywhere, never allowed to send/create/update.
function requireSession(session_token, opts) {
  opts = opts || {};
  const session = resolveSession(session_token);
  if (!session) return { error: 'Not identified yet - call identify_user_by_pin with your PIN first, then pass the session_token it returns to every other tool call.' };
  const user = session.user;
  if (opts.section && !hasPermission(user, opts.section)) return { error: `${user.name} doesn't have access to the ${opts.section} section.` };
  if (opts.anySection && !opts.anySection.some(s => hasPermission(user, s))) return { error: `${user.name} doesn't have access to any of: ${opts.anySection.join(', ')}.` };
  if (opts.blockBuyer && user.role === 'buyer') return { error: `${user.name}'s account is read-only here - buyer accounts can't send, create, or update anything.` };
  return { user };
}

const router = express.Router();

// Change this - it's the shared secret Claude uses to authenticate.
// Set a real value via the MCP_TOKEN environment variable in production;
// this default is only here so the app doesn't crash if it's unset.
const MCP_TOKEN = process.env.MCP_TOKEN || 'e6fa7c6787ddc5e695cf4842f8520b37b54de29abf99bbdcca4028fac292f7ed';

function requireMcpAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  if (token === MCP_TOKEN) return next(); // static token - Claude Desktop path
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE access_token = ?').get(token);
  if (row && row.expires_at > Date.now()) return next(); // OAuth token - web/mobile path
  return res.status(401).json({ error: 'Unauthorized' });
}

const PREFIXES = { Ladies: 'PL', Mens: 'PM', Kids: 'PK', Baby: 'PB' };

function buildServer() {
  const server = new McpServer({ name: 'docket-portal', version: '1.0.0' });

  server.tool(
    'identify_user_by_pin',
    'REQUIRED FIRST STEP before any other tool on this connector. Ask the caller for their PIN (set under Settings > Users) and give it here - on success this returns a session_token that must be passed as the session_token argument to every other tool call for the rest of this conversation, so those actions run as that real person (their name, their role\'s access, emails from their own address) rather than anonymously. The token expires after 2 hours - if a later call says the session is invalid/expired, call this again.',
    { pin: z.string().describe('4-6 digit PIN, as given - numerals ("1234") or spoken words ("one two three four") are both fine, no need to convert it yourself') },
    async ({ pin }) => {
      const user = findUserByPin(pin);
      if (!user) return { content: [{ type: 'text', text: 'No user matches that PIN.' }] };
      const { token, expiresAt } = createPinSession(user.id);
      return { content: [{ type: 'text', text: JSON.stringify({
        id: user.id, name: user.name, email: user.email, role: user.role,
        session_token: token, expires_at: new Date(expiresAt).toISOString(),
      }, null, 2) }] };
    }
  );

  server.tool(
    'get_style',
    'Get full details for one style by its style number (e.g. PL425), including comments and photo count. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), style_no: z.string().describe('Style number, e.g. PL425') },
    async ({ session_token, style_no }) => {
      const auth = requireSession(session_token, { section: 'styles' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const user = auth.user;
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      // Same retailer/department lock the app itself applies to buyer sessions.
      if (user.role === 'buyer' && (style.retailer !== user.retailer || style.department !== user.department)) {
        return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      }
      const comments = db.prepare('SELECT * FROM comments WHERE style_id = ? ORDER BY created_at ASC').all(style.id);
      const photoCount = db.prepare('SELECT COUNT(*) c FROM photos WHERE style_id = ?').get(style.id).c;
      const scoped = scopeStyleForRole(style, user);
      const summary = {
        style_no: scoped.style_no, retailer: scoped.retailer, department: scoped.department,
        buyer: scoped.buyer, description: scoped.description, stage: scoped.stage,
        // Details tab (mirrors the Concept drawer's own Details fields - see
        // public/js/drawer.js's renderBriefTab)
        fabric_code: scoped.fabric_code, composition: scoped.composition, weight: scoped.weight,
        colour: scoped.colour, wash: scoped.wash, print: scoped.print, embroidery_applique: scoped.embroidery_applique,
        topstitching: scoped.topstitch, trims: scoped.trims, styling: scoped.styling,
        units: scoped.units, packing: scoped.packing, labels: scoped.labels,
        source: scoped.source, tags: scoped.tags, concept_date: scoped.concept_date,
        factory: scoped.factory, shipping_date: scoped.shipping_date, dc_date: scoped.dc_date,
        target_rsp: scoped.target_rsp,
        cost_estimate: scoped.cost_estimate, buyer_rand_target: scoped.buyer_rand_target,
        buyer_rsp_target: scoped.buyer_rsp_target, factory_target_price: scoped.factory_target_price,
        factory_price: scoped.factory_price, factory_cost_options: scoped.factory_cost_options,
        photos: photoCount,
        comments: comments.map(c => `${c.author_name} (${c.author_role}): ${c.body}`)
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    'search_styles',
    'Search styles by retailer, department, pipeline stage, or a keyword in the description. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      retailer: z.string().optional().describe('e.g. PnP'),
      department: z.string().optional().describe('Ladies, Mens, Kids, or Baby'),
      stage: z.string().optional().describe('brief, doc_sent, costed, worksheet, proceed, or po'),
      keyword: z.string().optional().describe('Text to search for in the description'),
    },
    async ({ session_token, retailer, department, stage, keyword }) => {
      const auth = requireSession(session_token, { section: 'styles' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const user = auth.user;
      let rows = user.role === 'buyer'
        ? db.prepare('SELECT * FROM styles WHERE retailer = ? AND department = ?').all(user.retailer, user.department)
        : db.prepare('SELECT * FROM styles').all();
      if (retailer) rows = rows.filter(r => (r.retailer||'').toLowerCase().includes(retailer.toLowerCase()));
      if (department) rows = rows.filter(r => (r.department||'').toLowerCase() === department.toLowerCase());
      if (stage) rows = rows.filter(r => r.stage === stage);
      if (keyword) rows = rows.filter(r => (r.description||'').toLowerCase().includes(keyword.toLowerCase()));
      const summary = rows.map(r => ({
        style_no: r.style_no, description: r.description, retailer: r.retailer,
        department: r.department, stage: r.stage
      }));
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No matching styles found.' }] };
    }
  );

  server.tool(
    'update_stage',
    'Move a style to a new pipeline stage. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      style_no: z.string(),
      stage: z.enum(['brief', 'doc_sent', 'costed', 'worksheet', 'proceed', 'po'])
        .describe('brief=Brief In, doc_sent=Doc Sent, costed=Costed, worksheet=Worksheet In, proceed=Proceed Sent, po=PO Confirmed'),
    },
    async ({ session_token, style_no, stage }) => {
      const auth = requireSession(session_token, { section: 'styles', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      db.prepare('UPDATE styles SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, style.id);
      return { content: [{ type: 'text', text: `${style.style_no} moved to ${stage}` }] };
    }
  );

  server.tool(
    'add_comment',
    'Add a comment to a style (e.g. a note from a phone call or a quick update), attributed to the identified caller. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), style_no: z.string(), body: z.string() },
    async ({ session_token, style_no, body }) => {
      const auth = requireSession(session_token, { section: 'styles', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const user = auth.user;
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      db.prepare('INSERT INTO comments (style_id, author_name, author_role, body) VALUES (?,?,?,?)')
        .run(style.id, user.name, user.role, body);
      return { content: [{ type: 'text', text: `Comment added to ${style.style_no} as ${user.name}` }] };
    }
  );

  server.tool(
    'create_style',
    'Create a new style. The style number is auto-generated from the department prefix (PL/PM/PK/PB) unless you specify one. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      retailer: z.string().describe('e.g. PnP'),
      department: z.enum(['Ladies', 'Mens', 'Kids', 'Baby']),
      buyer: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ session_token, retailer, department, buyer, description }) => {
      const auth = requireSession(session_token, { section: 'styles', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const prefix = PREFIXES[department] || 'ST';
      const rows = db.prepare(`SELECT style_no FROM styles WHERE style_no LIKE ?`).all(prefix + '%');
      let max = 0;
      rows.forEach(r => {
        const n = parseInt(String(r.style_no).replace(prefix, ''), 10);
        if (!isNaN(n) && n > max) max = n;
      });
      const styleNo = prefix + String(max + 1).padStart(3, '0');
      db.prepare(`INSERT INTO styles (style_no, retailer, department, buyer, description, stage) VALUES (?,?,?,?,?, 'brief')`)
        .run(styleNo, retailer.trim(), department, (buyer||'').trim(), (description||'').trim());
      return { content: [{ type: 'text', text: `Created ${styleNo}` }] };
    }
  );

  // ---- Orders / Shipping ----
  // Curated summary rather than all ~70 raw columns (the orders table
  // carries full ORDER SCHEDULE spreadsheet parity, most of it finance/
  // invoicing detail that isn't useful over chat) - mirrors get_style's own
  // curated approach above. container is resolved live via container_id
  // rather than trusting the denormalized container_code column, which can
  // drift from the real assignment.
  function summarizeOrder(o) {
    const container = o.container_id ? db.prepare('SELECT container_no, code, vessel, container_type, etd, eta, delivered FROM containers WHERE id = ?').get(o.container_id) : null;
    const delays = db.prepare('SELECT old_date, new_date, reason, created_at FROM order_delays WHERE order_id = ? ORDER BY created_at ASC').all(o.id);
    return {
      id: o.id, order_no: o.order_no, style_no: o.style_no, description: o.description,
      units: o.units, cbm: o.cbm, rsp: o.rsp, colour: o.colour, season: o.season,
      po_delivery_date: o.po_delivery_date, ck_po_date: o.ck_po_date, actual_dc: o.actual_dc,
      dc_status: o.dc_status, bailed: !!o.bailed, fabric_code: o.fabric_code,
      sent_to_factory: o.sent_to_factory, labdip: o.labdip, fabric_test: o.fabric_test,
      fit: o.fit, preprod: o.preprod, preship: o.preship, units_shipped: o.units_shipped,
      container, delay_count: delays.length, delays,
    };
  }
  function findOrder({ order_no, style_no, id }) {
    if (id) return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (order_no) return db.prepare('SELECT * FROM orders WHERE order_no = ? COLLATE NOCASE').get(String(order_no).trim());
    if (style_no) return db.prepare('SELECT * FROM orders WHERE style_no = ? COLLATE NOCASE').get(String(style_no).trim());
    return null;
  }

  server.tool(
    'get_order',
    'Get one order/shipment by its order number or style number, including its container, delay history, and shipment status. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), order_no: z.string().optional(), style_no: z.string().optional() },
    async ({ session_token, order_no, style_no }) => {
      const auth = requireSession(session_token, { section: 'shipping' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const order = findOrder({ order_no, style_no });
      if (!order) return { content: [{ type: 'text', text: `No order found for ${order_no || style_no}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(summarizeOrder(order), null, 2) }] };
    }
  );

  server.tool(
    'search_orders',
    'Search orders/shipments by style number, description keyword, container code, or shipped/delivered status. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      keyword: z.string().optional().describe('Matches style_no, order_no, or description'),
      container_code: z.string().optional().describe('e.g. CK1'),
      bailed: z.boolean().optional().describe('true = already bailed/shipped, false = still awaiting'),
    },
    async ({ session_token, keyword, container_code, bailed }) => {
      const auth = requireSession(session_token, { section: 'shipping' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = db.prepare('SELECT * FROM orders').all();
      if (keyword) {
        const k = keyword.toLowerCase();
        rows = rows.filter(r => (r.style_no||'').toLowerCase().includes(k) || (r.order_no||'').toLowerCase().includes(k) || (r.description||'').toLowerCase().includes(k));
      }
      if (bailed !== undefined) rows = rows.filter(r => !!r.bailed === bailed);
      if (container_code) {
        const containerIds = db.prepare('SELECT id FROM containers WHERE code = ? COLLATE NOCASE').all(container_code.trim()).map(c => c.id);
        rows = rows.filter(r => containerIds.includes(r.container_id));
      }
      const summary = rows.map(r => ({ order_no: r.order_no, style_no: r.style_no, description: r.description, po_delivery_date: r.po_delivery_date, dc_status: r.dc_status, bailed: !!r.bailed }));
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No matching orders found.' }] };
    }
  );

  // Deliberately not the full ~70-column ORDER_FIELDS list routes/shipping.js
  // accepts - just the logistics/status fields a chat-driven update makes
  // sense for. Finance/invoicing columns (rand values, ROE, margins,
  // payment terms...) are edited in the app itself, where the full context
  // (and the numbers they're computed from) is visible.
  server.tool(
    'update_order',
    'Update logistics/status fields on an existing order - dates, quantities, production milestones. For the shipment date specifically, use log_order_delay instead so the change is tracked with a reason. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      order_no: z.string().optional(), style_no: z.string().optional(),
      dc_status: z.string().optional(),
      actual_dc: z.string().optional().describe('Actual DC date, YYYY-MM-DD'),
      units: z.string().optional(),
      colour: z.string().optional(),
      sent_to_factory: z.string().optional(),
      labdip: z.string().optional(),
      fabric_test: z.string().optional(),
      fit: z.string().optional(),
      preprod: z.string().optional(),
      preship: z.string().optional(),
      bailed: z.boolean().optional(),
    },
    async ({ session_token, order_no, style_no, ...fields }) => {
      const auth = requireSession(session_token, { section: 'shipping', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const order = findOrder({ order_no, style_no });
      if (!order) return { content: [{ type: 'text', text: `No order found for ${order_no || style_no}` }] };
      const updates = [];
      const values = [];
      Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) { updates.push(`${k} = ?`); values.push(k === 'bailed' ? (v ? 1 : 0) : v); } });
      if (!updates.length) return { content: [{ type: 'text', text: 'No fields given to update.' }] };
      values.push(order.id);
      db.prepare(`UPDATE orders SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return { content: [{ type: 'text', text: `Updated order ${order.order_no || order.style_no}` }] };
    }
  );

  server.tool(
    'log_order_delay',
    'Push out an order\'s shipment date and log why - builds the delay history shown as an escalation badge in the app (e.g. "4th" delay is worth flagging). Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), order_no: z.string().optional(), style_no: z.string().optional(), new_date: z.string().describe('YYYY-MM-DD'), reason: z.string() },
    async ({ session_token, order_no, style_no, new_date, reason }) => {
      const auth = requireSession(session_token, { section: 'shipping', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const order = findOrder({ order_no, style_no });
      if (!order) return { content: [{ type: 'text', text: `No order found for ${order_no || style_no}` }] };
      if (!reason || !reason.trim()) return { content: [{ type: 'text', text: 'A reason is required.' }] };
      db.prepare('INSERT INTO order_delays (order_id, old_date, new_date, reason) VALUES (?,?,?,?)')
        .run(order.id, order.po_delivery_date || null, new_date, reason.trim());
      db.prepare('UPDATE orders SET po_delivery_date = ? WHERE id = ?').run(new_date, order.id);
      const delayCount = db.prepare('SELECT COUNT(*) c FROM order_delays WHERE order_id = ?').get(order.id).c;
      return { content: [{ type: 'text', text: `${order.order_no || order.style_no} shipment date moved to ${new_date} (delay #${delayCount}: ${reason})` }] };
    }
  );

  server.tool(
    'search_containers',
    'List containers (optionally filtered by delivered status or a keyword), each with its assigned orders. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), delivered: z.boolean().optional(), keyword: z.string().optional().describe('Matches container code, container_no, or vessel') },
    async ({ session_token, delivered, keyword }) => {
      const auth = requireSession(session_token, { section: 'shipping' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = db.prepare('SELECT * FROM containers').all();
      if (delivered !== undefined) rows = rows.filter(c => !!c.delivered === delivered);
      if (keyword) {
        const k = keyword.toLowerCase();
        rows = rows.filter(c => (c.code||'').toLowerCase().includes(k) || (c.container_no||'').toLowerCase().includes(k) || (c.vessel||'').toLowerCase().includes(k));
      }
      const getOrders = db.prepare('SELECT order_no, style_no, description, units FROM orders WHERE container_id = ? ORDER BY sort_order ASC, id ASC');
      const summary = rows.map(c => ({ code: c.code, container_no: c.container_no, vessel: c.vessel, container_type: c.container_type, etd: c.etd, eta: c.eta, delivered: !!c.delivered, orders: getOrders.all(c.id) }));
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No matching containers found.' }] };
    }
  );

  // ---- Concepts ----
  const DEPT_CODES_MCP = { Ladies: 'L', Mens: 'M', Babywear: 'B', 'Younger Boys': 'YB', 'Older Boys': 'OB', 'Younger Girls': 'YG', 'Older Girls': 'OG' };
  function nextConceptNoMcp(department) {
    const code = DEPT_CODES_MCP[department] || 'X';
    const prefix = 'C' + code;
    const rows = db.prepare('SELECT concept_no FROM concepts WHERE concept_no LIKE ?').all(prefix + '%');
    let max = 0;
    rows.forEach(r => { const n = parseInt(String(r.concept_no).replace(prefix, ''), 10); if (!isNaN(n) && n > max) max = n; });
    return prefix + String(max + 1).padStart(3, '0');
  }
  // Same editable set as routes/concepts.js's CONCEPT_TEXT_FIELDS - every
  // free-text/money field on the concept except the FK-based spec/size
  // pickers (spec_category_id/size_range_id), which need the Spec Hierarchy
  // browsing tools to pick a valid id and aren't exposed here yet.
  const CONCEPT_TEXT_FIELDS_MCP = [
    'description', 'source', 'tags', 'cost_estimate', 'factory', 'shipping_date',
    'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
    'topstitching', 'trims', 'styling', 'units', 'packing', 'labels', 'dc_date',
    'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price', 'factory_cost_options'
  ];
  function specCategoryPathMcp(id) {
    const byId = {};
    db.prepare('SELECT id, parent_id, name FROM spec_categories').all().forEach(n => { byId[n.id] = n; });
    const names = [];
    let cur = byId[id];
    while (cur) { names.unshift(cur.name); cur = cur.parent_id ? byId[cur.parent_id] : null; }
    return names.join(' > ');
  }
  function findConcept(concept_no) {
    return db.prepare('SELECT * FROM concepts WHERE concept_no = ? COLLATE NOCASE').get(String(concept_no).trim());
  }

  server.tool(
    'get_concept',
    'Get full details for one concept by its concept number (e.g. CL011), including its spec category and reference photo count. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), concept_no: z.string() },
    async ({ session_token, concept_no }) => {
      const auth = requireSession(session_token, { section: 'concepts' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const concept = findConcept(concept_no);
      if (!concept) return { content: [{ type: 'text', text: `No concept found for ${concept_no}` }] };
      const photoCount = db.prepare('SELECT COUNT(*) c FROM concept_photos WHERE concept_id = ?').get(concept.id).c;
      const spec_path = concept.spec_category_id ? specCategoryPathMcp(concept.spec_category_id) : null;
      return { content: [{ type: 'text', text: JSON.stringify({ ...concept, spec_path, photos: photoCount }, null, 2) }] };
    }
  );

  server.tool(
    'search_concepts',
    'Search concepts by department or a keyword in the description. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), department: z.string().optional(), keyword: z.string().optional() },
    async ({ session_token, department, keyword }) => {
      const auth = requireSession(session_token, { section: 'concepts' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = db.prepare('SELECT * FROM concepts').all();
      if (department) rows = rows.filter(r => (r.department||'').toLowerCase() === department.toLowerCase());
      if (keyword) rows = rows.filter(r => (r.description||'').toLowerCase().includes(keyword.toLowerCase()));
      const summary = rows.map(r => ({ concept_no: r.concept_no, department: r.department, description: r.description, factory: r.factory }));
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No matching concepts found.' }] };
    }
  );

  server.tool(
    'create_concept',
    'Create a new concept. The concept number is auto-generated from the department. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), department: z.enum(['Ladies', 'Mens', 'Babywear', 'Younger Boys', 'Older Boys', 'Younger Girls', 'Older Girls']), description: z.string().optional() },
    async ({ session_token, department, description }) => {
      const auth = requireSession(session_token, { section: 'concepts', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const conceptNo = nextConceptNoMcp(department);
      db.prepare(`INSERT INTO concepts (concept_no, department, description, concept_date) VALUES (?,?,?,?)`)
        .run(conceptNo, department, (description||'').trim(), new Date().toISOString().slice(0,7));
      return { content: [{ type: 'text', text: `Created ${conceptNo}` }] };
    }
  );

  server.tool(
    'update_concept',
    'Update a concept\'s Details/Costing fields (fabric, colour, factory, pricing, etc). Requires session_token from identify_user_by_pin.',
    Object.fromEntries([
      ['session_token', z.string().optional()],
      ['concept_no', z.string()],
      ...CONCEPT_TEXT_FIELDS_MCP.map(f => [f, z.string().optional()]),
    ]),
    async ({ session_token, concept_no, ...fields }) => {
      const auth = requireSession(session_token, { section: 'concepts', blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const concept = findConcept(concept_no);
      if (!concept) return { content: [{ type: 'text', text: `No concept found for ${concept_no}` }] };
      const updates = [];
      const values = [];
      Object.entries(fields).forEach(([k, v]) => { if (v !== undefined) { updates.push(`${k} = ?`); values.push(v); } });
      if (!updates.length) return { content: [{ type: 'text', text: 'No fields given to update.' }] };
      values.push(concept.id);
      db.prepare(`UPDATE concepts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
      return { content: [{ type: 'text', text: `Updated ${concept.concept_no}` }] };
    }
  );

  server.tool(
    'get_factory_contact_for_concept',
    'Find the saved Factory contact (from Contacts) that best matches a concept\'s or a style\'s Factory field - use this to find a recipient email before calling send_request. Give one of concept_no or style_no. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), concept_no: z.string().optional(), style_no: z.string().optional() },
    async ({ session_token, concept_no, style_no }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'] });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      if (!concept_no && !style_no) return { content: [{ type: 'text', text: 'Give a concept_no or a style_no.' }] };
      let factoryField;
      if (style_no) {
        const style = findStyleByNo(style_no);
        if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
        factoryField = style.factory;
      } else {
        const concept = findConcept(concept_no);
        if (!concept) return { content: [{ type: 'text', text: `No concept found for ${concept_no}` }] };
        factoryField = concept.factory;
      }
      const factoryContacts = db.prepare(`
        SELECT c.*, f.name AS company FROM contacts c
        JOIN factories f ON f.id = c.factory_id
        ORDER BY f.name ASC
      `).all();
      let match = null;
      if (factoryField && factoryField.trim()) {
        const needle = factoryField.trim().toLowerCase();
        match = factoryContacts.find(c => (c.company || '').trim().toLowerCase() === needle)
          || factoryContacts.find(c => { const company = (c.company||'').trim().toLowerCase(); return company && (company.includes(needle) || needle.includes(company)); })
          || null;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ factory_field: factoryField, match, all_factory_contacts: factoryContacts.map(c => ({ name: `${c.first_name} ${c.last_name}`, company: c.company, email: c.email })) }, null, 2) }] };
    }
  );

  // ---- Requests (cost/quotation, sample, PP sample, bulk sample, fabric
  // test - see REQUEST_TYPES). A request can be sent from either a concept
  // (all 5 types) or a confirmed style (everything but cost - costing
  // negotiation happens at the concept stage, see routes/styles.js's
  // send-request route) - concept_id/concept_no/concept_description are set
  // for the former, style_id/style_no/style_description for the latter,
  // never both. ----
  function findStyleByNo(styleNo) {
    return db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get((styleNo || '').trim());
  }
  const STYLE_REQUEST_TYPES = ['sample', 'fit_sample', 'pp_sample', 'bulk_sample', 'fabric_test'];
  function summarizeRequest(r) {
    return {
      id: r.id, subject_type: r.concept_id ? 'concept' : 'style',
      concept_no: r.concept_no, concept_description: r.concept_description,
      style_no: r.style_no, style_description: r.style_description,
      request_type: r.request_type, message: r.message, sent_to: r.sent_to, sent_by_name: r.sent_by_name,
      subject: r.subject, status: r.status, received_at: r.received_at,
      reminder_count: r.reminder_count, last_reminder_at: r.last_reminder_at, created_at: r.created_at,
    };
  }

  server.tool(
    'list_requests',
    'List factory requests (cost/quotation, sample, PP sample, bulk sample, fabric test) sent from either a concept or a style, optionally filtered by status, type, concept_no, or style_no. Does not include the full email HTML - use get_request for one specific request\'s content. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      status: z.enum(['awaiting', 'received']).optional(),
      request_type: z.enum(['cost', 'sample', 'fit_sample', 'pp_sample', 'bulk_sample', 'fabric_test']).optional(),
      concept_no: z.string().optional(),
      style_no: z.string().optional(),
    },
    async ({ session_token, status, request_type, concept_no, style_no }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'] });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = db.prepare('SELECT * FROM concept_requests ORDER BY created_at DESC').all();
      if (status) rows = rows.filter(r => r.status === status);
      if (request_type) rows = rows.filter(r => r.request_type === request_type);
      if (concept_no) rows = rows.filter(r => (r.concept_no||'').toLowerCase() === concept_no.trim().toLowerCase());
      if (style_no) rows = rows.filter(r => (r.style_no||'').toLowerCase() === style_no.trim().toLowerCase());
      const summary = rows.map(summarizeRequest);
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No matching requests found.' }] };
    }
  );

  server.tool(
    'get_request',
    'Get one factory request\'s full details by id (message, status, reminder history). Excludes the rendered email HTML (large, includes embedded photos) - just the plain-text content. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number() },
    async ({ session_token, id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'] });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(id);
      if (!row) return { content: [{ type: 'text', text: `No request found with id ${id}` }] };
      const reminders = db.prepare('SELECT sent_by_name, created_at FROM request_reminders WHERE request_id = ? ORDER BY created_at ASC').all(id);
      return { content: [{ type: 'text', text: JSON.stringify({ ...summarizeRequest(row), reminders }, null, 2) }] };
    }
  );

  server.tool(
    'send_request',
    'Send a real factory request email for a concept or a style (cost/quotation, sample, PP sample, bulk sample, or fabric test report request) and log it. Give exactly one of concept_no or style_no - cost requests are concept-only (costing negotiation happens before a style exists). This actually sends an email via the configured mail service, from the identified caller\'s own address - use get_factory_contact_for_concept first if you don\'t already have a recipient address. Requires session_token from identify_user_by_pin.',
    {
      session_token: z.string().optional(),
      concept_no: z.string().optional(),
      style_no: z.string().optional(),
      request_type: z.enum(['cost', 'sample', 'fit_sample', 'pp_sample', 'bulk_sample', 'fabric_test']),
      to: z.string().describe('Recipient email address'),
      message: z.string().optional().describe('Required for every type except a concept cost request - what you need from the factory. Cost requests build their content from the concept\'s own saved fields instead.'),
    },
    async ({ session_token, concept_no, style_no, request_type, to, message }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const sender = auth.user;
      if (!mailIsConfigured()) return { content: [{ type: 'text', text: 'Email sending is not configured on the server.' }] };
      if (!concept_no && !style_no) return { content: [{ type: 'text', text: 'Give exactly one of concept_no or style_no.' }] };
      if (concept_no && style_no) return { content: [{ type: 'text', text: 'Give exactly one of concept_no or style_no, not both.' }] };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to || '')) return { content: [{ type: 'text', text: 'A valid recipient email is required.' }] };
      if (style_no && request_type === 'cost') return { content: [{ type: 'text', text: 'Cost requests are concept-only - a style already has a confirmed PO price.' }] };
      if (request_type !== 'cost' && !(message || '').trim()) return { content: [{ type: 'text', text: 'A message is required for this request type.' }] };

      try {
        let logoDataUrl = null;
        const logoPath = path.join(__dirname, '..', 'public', 'img', 'main-LOGO-transparent.PNG');
        if (fs.existsSync(logoPath)) logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');

        if (style_no) {
          const style = findStyleByNo(style_no);
          if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
          const photoRows = db.prepare('SELECT * FROM photos WHERE style_id = ? ORDER BY id ASC').all(style.id)
            .filter(p => p.role !== 'cad');
          const photos = [];
          for (const p of photoRows) {
            const fullPath = path.join(__dirname, '..', p.path);
            if (!fs.existsSync(fullPath)) continue;
            try {
              photos.push({ dataUrl: await imageFileToEmailDataUrl(fullPath) });
            } catch (e) { /* a broken/unreadable photo shouldn't fail the whole send */ }
          }
          const subjectObj = { concept_no: style.style_no, description: style.description, department: style.department };
          const messageZh = await translateMessage(message, openaiClient);
          const html = buildGenericRequestEmailHtml({ concept: subjectObj, requestType: request_type, message, messageZh, logoDataUrl, photos });
          const text = buildGenericRequestPlainText({ concept: subjectObj, requestType: request_type, message });
          const subject = `${REQUEST_TYPES[request_type].en} - ${style.style_no} - ${style.description || ''}`;

          const { from, replyTo } = resolveSender(sender);
          const result = await sendMail({ to, subject, html, text, from, replyTo });

          db.prepare(`
            INSERT INTO concept_requests (style_id, style_no, style_description, request_type, message, sent_to, sent_by_name, subject, html, resend_id)
            VALUES (?,?,?,?,?,?,?,?,?,?)
          `).run(style.id, style.style_no, style.description || '', request_type, message, to, sender.name, subject, html, result.id || null);

          return { content: [{ type: 'text', text: `Sent ${REQUEST_TYPES[request_type].en} for ${style.style_no} to ${to} as ${sender.name}` }] };
        }

        const concept = findConcept(concept_no);
        if (!concept) return { content: [{ type: 'text', text: `No concept found for ${concept_no}` }] };

        const specPath = concept.spec_category_id ? specCategoryPathMcp(concept.spec_category_id) : null;
        const photoRows = db.prepare('SELECT * FROM concept_photos WHERE concept_id = ? ORDER BY sort_order ASC, id ASC').all(concept.id)
          .filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
        const photos = [];
        for (const p of photoRows) {
          const fullPath = path.join(__dirname, '..', p.path);
          if (!fs.existsSync(fullPath)) continue;
          try {
            photos.push({ dataUrl: await imageFileToEmailDataUrl(fullPath) });
          } catch (e) { /* a broken/unreadable photo shouldn't fail the whole send */ }
        }

        let html, text, subject;
        if (request_type === 'cost') {
          const translations = await translateConceptFields({ ...concept, specPath }, openaiClient);
          html = buildCostingEmailHtml({ concept, specPath, translations, logoDataUrl, photos });
          text = buildCostingPlainText(concept, specPath);
          subject = `Quotation - ${concept.concept_no} - ${concept.description || ''}`;
        } else {
          const messageZh = await translateMessage(message, openaiClient);
          html = buildGenericRequestEmailHtml({ concept, requestType: request_type, message, messageZh, logoDataUrl, photos });
          text = buildGenericRequestPlainText({ concept, requestType: request_type, message });
          subject = `${REQUEST_TYPES[request_type].en} - ${concept.concept_no} - ${concept.description || ''}`;
        }

        const { from, replyTo } = resolveSender(sender);
        const result = await sendMail({ to, subject, html, text, from, replyTo });

        db.prepare(`
          INSERT INTO concept_requests (concept_id, concept_no, concept_description, request_type, message, sent_to, sent_by_name, subject, html, resend_id)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).run(concept.id, concept.concept_no, concept.description || '', request_type, request_type === 'cost' ? null : message, to, sender.name, subject, html, result.id || null);

        return { content: [{ type: 'text', text: `Sent ${REQUEST_TYPES[request_type].en} for ${concept.concept_no} to ${to} as ${sender.name}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'mark_request_status',
    'Mark a factory request as received (the factory replied) or awaiting (still waiting). Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number(), status: z.enum(['awaiting', 'received']) },
    async ({ session_token, id, status }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(id);
      if (!row) return { content: [{ type: 'text', text: `No request found with id ${id}` }] };
      db.prepare('UPDATE concept_requests SET status = ?, received_at = ? WHERE id = ?')
        .run(status, status === 'received' ? new Date().toISOString() : null, id);
      return { content: [{ type: 'text', text: `${row.concept_no || row.style_no} ${REQUEST_TYPES[row.request_type].en} marked as ${status}` }] };
    }
  );

  server.tool(
    'remind_request',
    'Send a short follow-up email nudging the factory about a request they haven\'t replied to yet, from the identified caller\'s own address. This actually sends an email. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number() },
    async ({ session_token, id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const sender = auth.user;
      if (!mailIsConfigured()) return { content: [{ type: 'text', text: 'Email sending is not configured on the server.' }] };
      const row = db.prepare('SELECT * FROM concept_requests WHERE id = ?').get(id);
      if (!row) return { content: [{ type: 'text', text: `No request found with id ${id}` }] };
      try {
        let logoDataUrl = null;
        const logoPath = path.join(__dirname, '..', 'public', 'img', 'main-LOGO-transparent.PNG');
        if (fs.existsSync(logoPath)) logoDataUrl = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
        const concept = row.concept_id
          ? { concept_no: row.concept_no, description: row.concept_description }
          : { concept_no: row.style_no, description: row.style_description };
        const originalDate = new Date(row.created_at).toLocaleDateString();
        const html = buildReminderEmailHtml({ concept, requestType: row.request_type, originalSubject: row.subject, originalDate, logoDataUrl });
        const text = buildReminderPlainText({ concept, requestType: row.request_type, originalSubject: row.subject, originalDate });
        const subject = `Reminder: ${row.subject}`;

        const { from, replyTo } = resolveSender(sender);
        await sendMail({ to: row.sent_to, subject, html, text, from, replyTo });

        const now = new Date().toISOString();
        db.prepare('UPDATE concept_requests SET reminder_count = reminder_count + 1, last_reminder_at = ? WHERE id = ?').run(now, id);
        db.prepare('INSERT INTO request_reminders (request_id, sent_by_name, created_at) VALUES (?,?,?)').run(id, sender.name, now);
        return { content: [{ type: 'text', text: `Reminder sent to ${row.sent_to} for ${row.concept_no || row.style_no} as ${sender.name}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Failed to send reminder: ${e.message}` }] };
      }
    }
  );

  // ---- Fabric Test Reports ----
  // The real uploaded/reviewed lab reports (fabric_test_reports) - distinct
  // from a request_type='fabric_test' entry in concept_requests above,
  // which only tracks whether someone *asked* the factory for one and
  // manually flagged the reply as received. This queries the actual
  // records, so it can give a verifiable answer rather than relying on a
  // manual status toggle.
  function reportsForFabricCode(code) {
    return db.prepare('SELECT * FROM fabric_test_reports WHERE fabric_code = ? COLLATE NOCASE ORDER BY COALESCE(report_date, created_at) DESC').all(code);
  }
  function reportsForStyleId(styleId) {
    return db.prepare('SELECT * FROM fabric_test_reports WHERE style_id = ? ORDER BY COALESCE(report_date, created_at) DESC').all(styleId);
  }
  // Reports are sometimes logged with a fabric_code that no longer matches
  // the style's *current* fabric_code (the style record can be edited after
  // the report was filed) and no style_id link either - the report's own
  // free-text style_no is then the only reliable match, so it's checked as
  // a third, independent path rather than folded into reportsForFabricCode.
  function reportsForStyleNo(styleNo) {
    return db.prepare('SELECT * FROM fabric_test_reports WHERE style_no = ? COLLATE NOCASE ORDER BY COALESCE(report_date, created_at) DESC').all(styleNo);
  }
  function summarizeReport(r) {
    return {
      id: r.id, report_type: r.report_type, report_number: r.report_number, report_date: r.report_date,
      overall_result: r.overall_result, fabric_code: r.fabric_code, style_no: r.style_no,
      composition: r.composition, weight_gsm: r.weight_gsm, weight_oz: r.weight_oz, created_at: r.created_at,
    };
  }

  server.tool(
    'search_fabric_test_reports',
    'Look up actual uploaded/reviewed fabric test lab reports (not just a request that was sent) by fabric code, style number, or concept number. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), fabric_code: z.string().optional(), style_no: z.string().optional(), concept_no: z.string().optional() },
    async ({ session_token, fabric_code, style_no, concept_no }) => {
      const auth = requireSession(session_token, { section: 'fabrics' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = [];
      if (fabric_code) rows = rows.concat(reportsForFabricCode(fabric_code));
      if (style_no) {
        rows = rows.concat(reportsForStyleNo(style_no.trim()));
        const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
        if (style) {
          rows = rows.concat(reportsForStyleId(style.id));
          if (style.fabric_code) rows = rows.concat(reportsForFabricCode(style.fabric_code));
        }
      }
      if (concept_no) {
        const concept = findConcept(concept_no);
        if (concept) {
          rows = rows.concat(reportsForStyleNo(concept.concept_no));
          if (concept.fabric_code) rows = rows.concat(reportsForFabricCode(concept.fabric_code));
        }
      }
      if (!fabric_code && !style_no && !concept_no) return { content: [{ type: 'text', text: 'Give at least one of fabric_code, style_no, or concept_no.' }] };
      const seen = new Set();
      const unique = rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(summarizeReport);
      return { content: [{ type: 'text', text: unique.length ? JSON.stringify(unique, null, 2) : 'No fabric test reports found.' }] };
    }
  );

  server.tool(
    'check_fabric_report_coverage',
    'The direct answer to "is there a fabric report for this concept/style yet" - checks the real uploaded reports against what\'s actually required (a base report always, plus a Print/Embellishment report if the concept/style has Print or Embroidery/Applique details), same rule the app\'s own banner uses. Give a concept_no or a style_no. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), concept_no: z.string().optional(), style_no: z.string().optional() },
    async ({ session_token, concept_no, style_no }) => {
      const auth = requireSession(session_token, { section: 'fabrics' });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      if (!concept_no && !style_no) return { content: [{ type: 'text', text: 'Give a concept_no or a style_no.' }] };

      let subject, fabricCode, printFlag, embroideryFlag, styleId = null, ownStyleNo = null;
      if (style_no) {
        const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
        if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
        subject = style.style_no; fabricCode = style.fabric_code; printFlag = style.print; embroideryFlag = style.embroidery_applique; styleId = style.id; ownStyleNo = style.style_no;
      } else {
        const concept = findConcept(concept_no);
        if (!concept) return { content: [{ type: 'text', text: `No concept found for ${concept_no}` }] };
        subject = concept.concept_no; fabricCode = concept.fabric_code; printFlag = concept.print; embroideryFlag = concept.embroidery_applique;
        // A converted concept's reports may only be logged against the
        // resulting style (uploaded after conversion, during production) -
        // check that too, not just the concept's own fabric code.
        const conversion = db.prepare('SELECT style_id FROM concept_conversions WHERE concept_id = ? ORDER BY created_at DESC LIMIT 1').get(concept.id);
        if (conversion) {
          styleId = conversion.style_id;
          const convertedStyle = db.prepare('SELECT style_no FROM styles WHERE id = ?').get(styleId);
          if (convertedStyle) ownStyleNo = convertedStyle.style_no;
        }
      }

      // A fabric_code match is only real coverage if the report isn't
      // explicitly tied to a *different* style - two styles cut from the
      // same fabric batch don't share a print/embellishment result just
      // because they share a fabric_code; a report naming another style_no
      // is that style's own test, not a generic fabric-level certificate.
      function isForeignStyleReport(report) {
        if (!report.style_no || !ownStyleNo) return false;
        return report.style_no.trim().toLowerCase() !== ownStyleNo.trim().toLowerCase();
      }

      let rows = fabricCode ? reportsForFabricCode(fabricCode).filter(r => !isForeignStyleReport(r)) : [];
      if (styleId) rows = rows.concat(reportsForStyleId(styleId));
      if (ownStyleNo) rows = rows.concat(reportsForStyleNo(ownStyleNo));
      const seen = new Set();
      rows = rows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)));

      const needsPrintReport = !!((printFlag && printFlag.trim()) || (embroideryFlag && embroideryFlag.trim()));
      const hasBase = rows.some(r => r.report_type !== 'print');
      const hasPrint = rows.some(r => r.report_type === 'print');
      const fullyCovered = hasBase && (!needsPrintReport || hasPrint);

      return { content: [{ type: 'text', text: JSON.stringify({
        subject, fabric_code: fabricCode || null,
        needs_print_report: needsPrintReport,
        has_base_report: hasBase, has_print_report: hasPrint,
        fully_covered: fullyCovered,
        reports_found: rows.map(summarizeReport),
      }, null, 2) }] };
    }
  );

  // ---- Inbound Email Inbox (AI-matched factory/buyer mail) ----
  // Voice/chat parity for the Review Inbox UI (public/js/inboxDemo.js is
  // still the mock-data prototype at time of writing - these tools drive
  // the same real backend, see lib/emailMatch.js / lib/emailExtract.js /
  // lib/emailApply.js, that a real web UI will eventually call too, so
  // there's exactly one place field changes ever actually get written).
  // Gated with blockBuyer like the other cost/factory-sensitive tools
  // (send_request, update_order) - inbound mail can carry costing/factory
  // detail a buyer account shouldn't see.
  function summarizeInboundEmail(row) {
    const pendingCount = db.prepare(`SELECT COUNT(*) c FROM inbound_email_field_changes WHERE inbound_email_id = ? AND status = 'pending'`).get(row.id).c;
    return {
      id: row.id, from: row.from_email, subject: row.subject, received_at: row.received_at,
      match_status: row.match_status, match_type: row.match_type,
      match_record: row.match_type ? emailRecordLabel(row.match_type, row.match_id) : null,
      pending_changes: pendingCount,
    };
  }
  function resolveRecordIdMcp(recordType, recordNo) {
    if (recordType === 'concept') { const c = findConcept(recordNo); return c ? c.id : null; }
    if (recordType === 'style') { const s = findStyleByNo(recordNo); return s ? s.id : null; }
    if (recordType === 'order') { const o = findOrder({ order_no: recordNo, style_no: recordNo }); return o ? o.id : null; }
    return null;
  }

  server.tool(
    'list_inbound_emails',
    'List inbound emails Docket has matched to concepts/styles/orders (from crm@portal.elanzas.com), optionally filtered by match status. Each entry shows how many field changes are still pending review. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), match_status: z.enum(['matched', 'multiple', 'unmatched']).optional() },
    async ({ session_token, match_status }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      let rows = db.prepare(`SELECT * FROM inbound_emails WHERE fetch_status = 'fetched' ORDER BY created_at DESC`).all();
      if (match_status) rows = rows.filter(r => r.match_status === match_status);
      const summary = rows.map(summarizeInboundEmail);
      return { content: [{ type: 'text', text: summary.length ? JSON.stringify(summary, null, 2) : 'No inbound emails found.' }] };
    }
  );

  server.tool(
    'get_inbound_email',
    'Get one inbound email\'s full body, its match (or candidate list, if still ambiguous), and every proposed field change with its current/proposed value and the exact source snippet. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number() },
    async ({ session_token, id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const row = db.prepare('SELECT * FROM inbound_emails WHERE id = ?').get(id);
      if (!row) return { content: [{ type: 'text', text: `No inbound email found with id ${id}` }] };
      const changes = db.prepare(`SELECT id, field_name, field_label, current_value, proposed_value, source_snippet, status FROM inbound_email_field_changes WHERE inbound_email_id = ? ORDER BY id ASC`).all(id);
      const candidates = row.match_status === 'multiple' && row.match_candidates_json ? JSON.parse(row.match_candidates_json) : null;
      return { content: [{ type: 'text', text: JSON.stringify({
        id: row.id, from: row.from_email, subject: row.subject, received_at: row.received_at, body: row.text_body,
        match_status: row.match_status, match_type: row.match_type,
        match_record: row.match_type ? emailRecordLabel(row.match_type, row.match_id) : null,
        candidates, changes,
      }, null, 2) }] };
    }
  );

  server.tool(
    'resolve_inbound_email_match',
    'Tell Docket which real concept/style/order an inbound email is actually about - use this both to pick the right one when get_inbound_email showed multiple candidates, and to manually link an email that came back unmatched. Immediately re-runs field-change extraction against the confirmed record. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number(), record_type: z.enum(['concept', 'style', 'order']), record_no: z.string().describe('The concept number, style number, or order/style number for an order') },
    async ({ session_token, id, record_type, record_no }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const recordId = resolveRecordIdMcp(record_type, record_no);
      if (!recordId) return { content: [{ type: 'text', text: `No ${record_type} found for ${record_no}` }] };
      try {
        const { record, changes } = await resolveEmailMatch(id, record_type, recordId, openaiClient);
        return { content: [{ type: 'text', text: `Linked to ${record_type} ${record.no}. ${changes.length ? `${changes.length} field change(s) proposed - review with get_inbound_email.` : 'No field changes proposed from this email.'}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'apply_inbound_email_change',
    'Apply one specific proposed field change from an inbound email to the real concept/style/order record. Get the change id from get_inbound_email first. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), change_id: z.number() },
    async ({ session_token, change_id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      try {
        const change = applyEmailChange(change_id);
        return { content: [{ type: 'text', text: `Applied: ${change.field_label} → ${change.proposed_value}${change.email_deleted ? ' - that was the last pending change, so the email has been removed from the inbox.' : ''}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'decline_inbound_email_change',
    'Decline one specific proposed field change from an inbound email - it stays on record as declined, nothing is written to the real concept/style/order. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), change_id: z.number() },
    async ({ session_token, change_id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      try {
        const change = declineEmailChange(change_id);
        return { content: [{ type: 'text', text: `Declined: ${change.field_label}${change.email_deleted ? ' - that was the last pending change, so the email has been removed from the inbox.' : ''}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }] };
      }
    }
  );

  server.tool(
    'apply_all_inbound_email_changes',
    'Apply every still-pending proposed field change for one inbound email in a single action. If that resolves every change on the email, it is removed from the inbox. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number() },
    async ({ session_token, id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const { results, email_deleted } = applyAllEmailChanges(id);
      if (!results.length) return { content: [{ type: 'text', text: 'No pending changes for this email.' }] };
      const failed = results.filter(r => !r.ok);
      return { content: [{ type: 'text', text: `Applied ${results.length - failed.length}/${results.length} change(s).${failed.length ? ' Failed: ' + failed.map(f => `${f.field_name} (${f.error})`).join(', ') : ''}${email_deleted ? ' Email fully resolved and removed from the inbox.' : ''}` }] };
    }
  );

  server.tool(
    'decline_all_inbound_email_changes',
    'Decline every still-pending proposed field change for one inbound email in a single action. If that resolves every change on the email, it is removed from the inbox. Requires session_token from identify_user_by_pin.',
    { session_token: z.string().optional(), id: z.number() },
    async ({ session_token, id }) => {
      const auth = requireSession(session_token, { anySection: ['concepts', 'styles', 'shipping'], blockBuyer: true });
      if (auth.error) return { content: [{ type: 'text', text: auth.error }] };
      const { results, email_deleted } = declineAllEmailChanges(id);
      if (!results.length) return { content: [{ type: 'text', text: 'No pending changes for this email.' }] };
      return { content: [{ type: 'text', text: `Declined ${results.length} change(s).${email_deleted ? ' Email fully resolved and removed from the inbox.' : ''}` }] };
    }
  );

  return server;
}

// Stateless mode: builds a fresh McpServer + transport per HTTP request -
// each tool call is still a quick, independent database read/write. The one
// thing that *does* need to persist across calls (which PIN-verified user a
// caller is) is carried in the session_token argument itself, resolved
// against the mcp_pin_sessions table (see requireSession above) rather than
// kept in any server-side memory - so this stays fully stateless per request
// while still supporting a multi-call "logged in" conversation.
router.post('/', requireMcpAuth, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error', e);
    if (!res.headersSent) res.status(500).json({ error: 'MCP server error' });
  }
});

router.get('/', requireMcpAuth, (req, res) => {
  res.status(405).json({ error: 'This endpoint only supports POST (stateless MCP over Streamable HTTP).' });
});

module.exports = router;