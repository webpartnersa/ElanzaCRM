const express = require('express');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { db } = require('../db');

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
    'get_style',
    'Get full details for one style by its style number (e.g. PL425), including comments and photo count.',
    { style_no: z.string().describe('Style number, e.g. PL425') },
    async ({ style_no }) => {
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      const comments = db.prepare('SELECT * FROM comments WHERE style_id = ? ORDER BY created_at ASC').all(style.id);
      const photoCount = db.prepare('SELECT COUNT(*) c FROM photos WHERE style_id = ?').get(style.id).c;
      const summary = {
        style_no: style.style_no, retailer: style.retailer, department: style.department,
        buyer: style.buyer, description: style.description, stage: style.stage,
        fabric: style.fabric, colour: style.colour, wash: style.wash,
        units: style.units, target_rsp: style.target_rsp, cost: style.cost, margin: style.margin,
        factory: style.factory, first_ship: style.first_ship, first_delivery: style.first_delivery,
        photos: photoCount,
        comments: comments.map(c => `${c.author_name} (${c.author_role}): ${c.body}`)
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.tool(
    'search_styles',
    'Search styles by retailer, department, pipeline stage, or a keyword in the description.',
    {
      retailer: z.string().optional().describe('e.g. Pick n Pay'),
      department: z.string().optional().describe('Ladies, Mens, Kids, or Baby'),
      stage: z.string().optional().describe('brief, doc_sent, costed, worksheet, proceed, or po'),
      keyword: z.string().optional().describe('Text to search for in the description'),
    },
    async ({ retailer, department, stage, keyword }) => {
      let rows = db.prepare('SELECT * FROM styles').all();
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
    'Move a style to a new pipeline stage.',
    {
      style_no: z.string(),
      stage: z.enum(['brief', 'doc_sent', 'costed', 'worksheet', 'proceed', 'po'])
        .describe('brief=Brief In, doc_sent=Doc Sent, costed=Costed, worksheet=Worksheet In, proceed=Proceed Sent, po=PO Confirmed'),
    },
    async ({ style_no, stage }) => {
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      db.prepare('UPDATE styles SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, style.id);
      return { content: [{ type: 'text', text: `${style.style_no} moved to ${stage}` }] };
    }
  );

  server.tool(
    'add_comment',
    'Add a comment to a style (e.g. a note from a phone call or a quick update).',
    { style_no: z.string(), body: z.string() },
    async ({ style_no, body }) => {
      const style = db.prepare('SELECT * FROM styles WHERE style_no = ? COLLATE NOCASE').get(style_no.trim());
      if (!style) return { content: [{ type: 'text', text: `No style found for ${style_no}` }] };
      db.prepare('INSERT INTO comments (style_id, author_name, author_role, body) VALUES (?,?,?,?)')
        .run(style.id, 'Claude (voice/chat)', 'admin', body);
      return { content: [{ type: 'text', text: `Comment added to ${style.style_no}` }] };
    }
  );

  server.tool(
    'create_style',
    'Create a new style. The style number is auto-generated from the department prefix (PL/PM/PK/PB) unless you specify one.',
    {
      retailer: z.string().describe('e.g. Pick n Pay'),
      department: z.enum(['Ladies', 'Mens', 'Kids', 'Baby']),
      buyer: z.string().optional(),
      description: z.string().optional(),
    },
    async ({ retailer, department, buyer, description }) => {
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

  return server;
}

// Stateless mode: builds a fresh server + transport per request. Simpler
// and sufficient here since every tool call is a quick database read/write
// with no need to remember anything between calls.
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