// Phase 3 of the inbound email inbox: for an email Phase 2 already matched
// to a concept/style/order, propose field changes for a human to review
// (Phase 4) and apply (Phase 5) - this module only stages rows in
// inbound_email_field_changes, it never writes to concepts/styles/orders
// itself. See lib/emailMatch.js for how match_type/match_id get set.
const { db } = require('../db');

// Deliberately a curated subset of each table's real columns (see db.js's
// CREATE TABLE / ensureColumn history), not every column - these are the
// fields a factory/buyer email plausibly updates. Keeping the list tight
// also keeps the LLM's field_name output constrained to values the review
// UI actually knows how to render/apply, since extractFieldChanges below
// drops anything outside this list rather than trusting the model.
const FIELD_DEFS = {
  concept: {
    table: 'concepts',
    fields: {
      description: 'Description', factory: 'Factory',
      cost_estimate: 'Cost Estimate', lead_time_note: 'Lead Time',
    },
  },
  style: {
    table: 'styles',
    fields: {
      description: 'Description', fabric: 'Fabric', colour: 'Colour', wash: 'Wash',
      units: 'Units', cost: 'Cost', target_rsp: 'Target RSP', factory: 'Factory',
      first_ship: 'First Ship Date', first_delivery: 'First Delivery Date',
      composition: 'Composition', weight: 'Weight',
    },
  },
  order: {
    table: 'orders',
    fields: {
      units: 'Units', po_price: 'PO Price', po_delivery_date: 'PO Delivery Date',
      actual_dc: 'Actual DC Date', payment_due: 'Payment Due',
      invoice_value: 'Invoice Value', colour: 'Colour', composition: 'Composition',
    },
  },
};

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

function normalize(v) {
  return (v === null || v === undefined ? '' : String(v)).trim().toLowerCase();
}

function getCurrentRecord(matchType, matchId) {
  const def = FIELD_DEFS[matchType];
  if (!def) return null;
  return db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(matchId);
}

function buildPrompt(matchType, record, def, row) {
  const knownFields = Object.keys(def.fields).map(f => `- ${f} ("${def.fields[f]}"): currently ${JSON.stringify(record[f] ?? null)}`).join('\n');
  const body = (row.text_body || stripHtml(row.html_body || '')).slice(0, 6000);
  return `You are reading a real work email for a clothing merchandising CRM, already matched to an existing ${matchType} record. Decide which of the record's known fields this email provides NEW, EXPLICIT information for - do not guess, infer, or propose a value the email doesn't clearly state.

Known fields and their CURRENT saved values:
${knownFields}

Return ONLY a JSON object: { "changes": [ { "field": string (must be exactly one of the field names listed above), "proposed_value": string (the new value, in the same format/units as the current value where relevant), "source_snippet": string (the EXACT sentence or phrase from the email body below that states this - copied verbatim, not paraphrased) } ] }

Rules:
- Only include a field if the email states a value that is different from its current value, or newly provides a value where the current one is empty.
- Never include a field the email doesn't mention.
- source_snippet must be an exact substring of the email body below - do not paraphrase or summarize it.
- Return { "changes": [] } if nothing in the email proposes a real change.

From: ${row.from_email || ''}
Subject: ${row.subject || ''}
Email body:
${body}`;
}

// Runs Phase 3 for one already-matched, already-classified row. Safe to
// call more than once for the same email (e.g. from extractSweep after a
// process restart) - clears this email's own still-pending proposals
// before inserting fresh ones, rather than accumulating duplicates; a
// field a human already applied or declined is untouched (see status
// filter below), matching the "declined fields are marked declined, not
// deleted" rule from Phase 5 of the brief.
async function extractFieldChanges(resendEmailId, openaiClient) {
  const row = db.prepare('SELECT * FROM inbound_emails WHERE resend_email_id = ?').get(resendEmailId);
  if (!row) return [];

  const def = row.match_type ? FIELD_DEFS[row.match_type] : null;
  const record = def ? getCurrentRecord(row.match_type, row.match_id) : null;

  let changes = [];
  if (def && record && openaiClient) {
    const prompt = buildPrompt(row.match_type, record, def, row);
    const res = await openaiClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });
    try {
      const data = JSON.parse(res.choices[0].message.content);
      changes = Array.isArray(data.changes) ? data.changes : [];
    } catch (e) {
      changes = [];
    }
  }

  // Defense against hallucinated field names / no-op "changes" that
  // actually match the current value already - the LLM is instructed not
  // to produce these but isn't trusted to always comply.
  const filtered = changes.filter(c =>
    c && def && def.fields[c.field] &&
    typeof c.proposed_value === 'string' && c.proposed_value.trim() &&
    normalize(c.proposed_value) !== normalize(record[c.field])
  );

  db.transaction(() => {
    db.prepare(`DELETE FROM inbound_email_field_changes WHERE inbound_email_id = ? AND status = 'pending'`).run(row.id);
    const insert = db.prepare(`
      INSERT INTO inbound_email_field_changes
        (inbound_email_id, field_name, field_label, current_value, proposed_value, source_snippet)
      VALUES (?,?,?,?,?,?)
    `);
    filtered.forEach(c => {
      insert.run(row.id, c.field, def.fields[c.field], record[c.field] ?? null, c.proposed_value.trim(), c.source_snippet || null);
    });
    db.prepare(`UPDATE inbound_emails SET extracted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  })();

  return filtered;
}

module.exports = { extractFieldChanges, FIELD_DEFS, getCurrentRecord };
