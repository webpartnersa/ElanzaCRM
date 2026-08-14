// Phase 2 of the inbound email inbox: classify a stored inbound_emails row
// as work-related or not, then attempt to match it to an existing concept,
// style, or order. Nothing is written to those records here - this only
// decides what to show a human in the future Review Inbox (Phase 4) and
// stages nothing beyond the inbound_emails row itself (Phase 3 does the
// actual field-change staging, once a match exists).
const { db } = require('../db');

// Same department code convention used everywhere a concept/style number is
// built or parsed (routes/concepts.js's nextConceptNo, routes/styles.js's
// nextStyleNo) - kept in sync manually since there's no shared module for
// it in the rest of the app either.
const DEPT_CODES = ['L', 'M', 'B', 'YB', 'OB', 'YG', 'OG'];
const RETAILER_CODES = ['P', 'E', 'PE'];

// Matches both concept numbers ("C" + dept code + digits, e.g. CYB005) and
// style numbers (retailer code + dept code + digits, e.g. PL021, PEYB003).
// A concept can also be manually renamed away from that pattern (see
// feedback_never_delete_unfamiliar_records memory - PB005 is a real,
// manually-renamed concept, not a style) - that's exactly why every code
// hit below is looked up against BOTH concepts and styles rather than
// assuming the prefix tells you which table it's in.
const CODE_RE = new RegExp(
  `\\b(?:C(?:${DEPT_CODES.join('|')})|(?:${RETAILER_CODES.join('|')})(?:${DEPT_CODES.join('|')}))\\d{2,4}\\b`,
  'gi'
);
// Legacy orders data uses a bare "ELA-" + code format with no styles row
// behind it at all (see orders.style_no e.g. "ELA-PL021B") - orders must be
// matched on style_no as free text, never assumed to join to styles.
const LEGACY_RE = /\bELA-([A-Z]{1,3}\d{2,4}[A-Z]?)\b/gi;
// Buyer PO / order numbers are just long digit runs with no fixed shape
// across retailers (see the real "PO 4769868977" test file from the
// order-doc cross-check feature) - too loose to be a signal on its own,
// only used to probe orders.order_no for an exact hit.
const PO_RE = /\b\d{6,12}\b/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

function candidateKey(c) { return c.type + ':' + c.id; }

function findByCode(code) {
  const out = [];
  const concept = db.prepare('SELECT id, concept_no AS no, description FROM concepts WHERE concept_no = ? COLLATE NOCASE').get(code);
  if (concept) out.push({ type: 'concept', id: concept.id, no: concept.no, label: concept.description || concept.no });
  const style = db.prepare('SELECT id, style_no AS no, description FROM styles WHERE style_no = ? COLLATE NOCASE').get(code);
  if (style) out.push({ type: 'style', id: style.id, no: style.no, label: style.description || style.no });
  const order = db.prepare('SELECT id, order_no, style_no, description FROM orders WHERE style_no = ? COLLATE NOCASE').get(code);
  if (order) out.push({ type: 'order', id: order.id, no: order.style_no, label: order.description || order.style_no });
  return out;
}

function findByOrderNo(no) {
  const rows = db.prepare('SELECT id, order_no, style_no, description FROM orders WHERE order_no = ?').all(no);
  return rows.map(o => ({ type: 'order', id: o.id, no: o.order_no, label: o.description || o.order_no }));
}

// A direct reply to a request we sent (see concept_requests.resend_id,
// set from sendMail()'s own Resend response id) is the strongest possible
// signal - best-effort because Resend's own Message-ID header format on
// the original send isn't documented/guaranteed, so this just looks for
// that id surfacing anywhere in the reply's thread headers rather than
// assuming an exact header shape.
function findByThreadHeaders(inReplyTo, referencesHeader) {
  const haystack = `${inReplyTo || ''} ${referencesHeader || ''}`;
  const ids = haystack.match(UUID_RE) || [];
  const out = [];
  for (const id of ids) {
    const reqRow = db.prepare('SELECT concept_id, concept_no, concept_description FROM concept_requests WHERE resend_id = ?').get(id);
    if (reqRow) out.push({ type: 'concept', id: reqRow.concept_id, no: reqRow.concept_no, label: reqRow.concept_description || reqRow.concept_no, via: 'thread-reply' });
  }
  return out;
}

// Sender domain/address is a weak, supporting signal only (see
// get_factory_contact_for_concept in routes/mcp.js for the same
// company-name matching convention) - a factory can have many open
// concepts/styles at once, so this alone should never produce a single
// confident match, only help disambiguate or explain a "multiple" result.
function findByFactoryContact(fromEmail) {
  if (!fromEmail) return [];
  const contact = db.prepare('SELECT company FROM contacts WHERE LOWER(email) = LOWER(?)').get(fromEmail.trim());
  if (!contact || !contact.company) return [];
  const needle = contact.company.trim().toLowerCase();
  const out = [];
  db.prepare("SELECT id, concept_no AS no, description, factory FROM concepts WHERE factory IS NOT NULL AND factory != ''").all()
    .filter(c => (c.factory || '').trim().toLowerCase() === needle)
    .forEach(c => out.push({ type: 'concept', id: c.id, no: c.no, label: c.description || c.no, via: 'sender-domain' }));
  db.prepare("SELECT id, style_no AS no, description, factory FROM styles WHERE factory IS NOT NULL AND factory != ''").all()
    .filter(s => (s.factory || '').trim().toLowerCase() === needle)
    .forEach(s => out.push({ type: 'style', id: s.id, no: s.no, label: s.description || s.no, via: 'sender-domain' }));
  return out;
}

function extractCodes(text) {
  const codes = new Set();
  (text.match(CODE_RE) || []).forEach(c => codes.add(c.toUpperCase()));
  let m;
  LEGACY_RE.lastIndex = 0;
  while ((m = LEGACY_RE.exec(text))) codes.add(m[0].toUpperCase()); // keep the full "ELA-..." form - that's what's actually stored in orders.style_no
  return [...codes];
}

// Deterministic pass - no LLM involved. Returns { status, type, id,
// confidence, candidates } where status is 'matched' | 'multiple' |
// 'unmatched', matching the three outcomes the brief calls for.
function matchEmail(row) {
  const subject = row.subject || '';
  const body = `${row.text_body || ''} ${stripHtml(row.html_body || '')}`;
  const searchText = `${subject} ${body}`;

  const threadHits = findByThreadHeaders(row.in_reply_to, row.references_header);
  if (threadHits.length === 1) {
    return { status: 'matched', type: threadHits[0].type, id: threadHits[0].id, confidence: 0.97, candidates: threadHits };
  }

  const codes = extractCodes(searchText);
  const poNumbers = searchText.match(PO_RE) || [];
  let codeHits = [];
  codes.forEach(code => { codeHits = codeHits.concat(findByCode(code)); });
  poNumbers.forEach(no => { codeHits = codeHits.concat(findByOrderNo(no)); });

  const byKey = new Map();
  [...threadHits, ...codeHits].forEach(c => byKey.set(candidateKey(c), c));
  const strongCandidates = [...byKey.values()];

  if (strongCandidates.length === 1) {
    return { status: 'matched', type: strongCandidates[0].type, id: strongCandidates[0].id, confidence: 0.9, candidates: strongCandidates };
  }
  if (strongCandidates.length > 1) {
    return { status: 'multiple', type: null, id: null, confidence: 0.5, candidates: strongCandidates };
  }

  // No code/thread hit at all - fall back to the weak sender-domain signal,
  // which can only ever produce 'multiple' or 'unmatched', never a single
  // confident match on its own (see findByFactoryContact above).
  const senderHits = findByFactoryContact(row.from_email);
  const senderByKey = new Map();
  senderHits.forEach(c => senderByKey.set(candidateKey(c), c));
  const senderCandidates = [...senderByKey.values()];
  if (senderCandidates.length === 1) {
    return { status: 'multiple', type: null, id: null, confidence: 0.3, candidates: senderCandidates };
  }
  if (senderCandidates.length > 1) {
    return { status: 'multiple', type: null, id: null, confidence: 0.25, candidates: senderCandidates };
  }
  return { status: 'unmatched', type: null, id: null, confidence: 0, candidates: [] };
}

const CLASSIFY_PROMPT = `You are triaging an inbound email for a clothing merchandising company (Elanzas) whose CRM only cares about business-relevant mail: replies from garment/fabric factories, buyer/retailer inquiries about styles or orders, or logistics/shipping correspondence. Everything else - newsletters, marketing, spam, personal mail, automated notifications unrelated to garment orders - is not work-related for this system's purposes.

Return ONLY a JSON object: { "is_work_related": boolean, "reason": string (one short sentence) }.

From: {{from}}
Subject: {{subject}}
Body:
{{body}}`;

async function classifyWorkRelated(row, openaiClient) {
  if (!openaiClient) return { is_work_related: null, reason: 'OPENAI_API_KEY not configured' };
  const body = (row.text_body || stripHtml(row.html_body || '')).slice(0, 4000);
  const prompt = CLASSIFY_PROMPT
    .replace('{{from}}', row.from_email || '')
    .replace('{{subject}}', row.subject || '')
    .replace('{{body}}', body);
  const res = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  try {
    const data = JSON.parse(res.choices[0].message.content);
    return { is_work_related: !!data.is_work_related, reason: data.reason || null };
  } catch (e) {
    return { is_work_related: null, reason: 'Could not parse classification response' };
  }
}

// Runs classification + matching for one already-fetched row and persists
// the result. Skips matching entirely (cheap - saves the DB scans) when
// the email isn't work-related, since nothing downstream needs it matched.
async function classifyAndMatch(resendEmailId, openaiClient) {
  const row = db.prepare('SELECT * FROM inbound_emails WHERE resend_email_id = ?').get(resendEmailId);
  if (!row) return;

  const { is_work_related } = await classifyWorkRelated(row, openaiClient);

  let result = { status: 'unmatched', type: null, id: null, confidence: 0, candidates: [] };
  if (is_work_related !== false) result = matchEmail(row);

  db.prepare(`
    UPDATE inbound_emails SET
      is_work_related = ?, match_status = ?, match_type = ?, match_id = ?,
      match_confidence = ?, match_candidates_json = ?, classified_at = CURRENT_TIMESTAMP
    WHERE resend_email_id = ?
  `).run(
    is_work_related === null ? null : (is_work_related ? 1 : 0),
    result.status, result.type, result.id, result.confidence,
    JSON.stringify(result.candidates), resendEmailId
  );
  return result;
}

module.exports = { classifyAndMatch, classifyWorkRelated, matchEmail, extractCodes };
