// Phase 3 of the inbound email inbox: for an email Phase 2 already matched
// to a concept/style/order, propose field changes for a human to review
// (Phase 4) and apply (Phase 5) - this module only stages rows in
// inbound_email_field_changes, it never writes to concepts/styles/orders
// itself. See lib/emailMatch.js for how match_type/match_id get set.
const { db } = require('../db');

// Deliberately a curated subset of each table's real columns, not every
// column - these are the fields a factory/buyer email plausibly updates.
// Keeping the list tight also keeps the LLM's field_name output constrained
// to values the review UI actually knows how to render/apply, since
// extractFieldChanges below drops anything outside this list rather than
// trusting the model.
//
// Every field name here MUST be one the live edit routes actually persist
// (routes/concepts.js's CONCEPT_TEXT_FIELDS, routes/styles.js's PUT /:id
// `fields` array, routes/shipping.js's ORDER_FIELDS) - concepts/styles both
// still carry older, now-dead columns (styles.fabric/cost/first_ship/
// first_delivery, concepts.lead_time_note) that those routes stopped
// writing to years ago in favour of fabric_code/composition/weight,
// cost_estimate, and shipping_date/dc_date respectively. Proposing a change
// against a dead column would silently write somewhere the real app (and
// lib/emailApply.js, which applies these) never reads back from.
const FIELD_DEFS = {
  concept: {
    table: 'concepts',
    fields: {
      description: 'Description', factory: 'Factory', cost_estimate: 'Cost Estimate',
      fabric_code: 'Fabric', composition: 'Composition', weight: 'Weight',
      colour: 'Colour', units: 'Units', shipping_date: 'Shipping Date',
    },
  },
  style: {
    table: 'styles',
    fields: {
      description: 'Description', fabric_code: 'Fabric', colour: 'Colour', wash: 'Wash',
      units: 'Units', cost_estimate: 'Cost Estimate', target_rsp: 'Target RSP', factory: 'Factory',
      shipping_date: 'Shipping Date', dc_date: 'DC Date',
      composition: 'Composition', weight: 'Weight',
    },
  },
  order: {
    table: 'orders',
    fields: {
      units: 'Units', po_price: 'PO Price', po_delivery_date: 'PO Delivery Date',
      actual_dc: 'Actual DC Date', payment_due: 'Payment Due',
      invoice_value: 'Invoice Value', colour: 'Colour', composition: 'Composition',
      fit: 'Fit Date', fabric_approved: 'Date Fabric Approved',
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

// Driven by the key-point summary Phase 2 already produced (see
// lib/emailMatch.js's classifyWorkRelated), not a hand-written list of
// prose edge-case rules re-litigating what counts each time a new failure
// mode turns up. Each key point is already a specific, standalone fact
// (with any inferred date already folded in at summarization time, not
// here) - matching THOSE against the known fields, instead of re-deriving
// facts from the raw body itself, is what keeps this step from conflating
// two different fields that both happen to mention "date" or "approved"
// (a real bug this replaced - see git history). Deliberately no date-
// inference logic here at all - if a key point doesn't already state a
// value, this step isn't the place to go guess one.
function buildPrompt(matchType, record, def, row, keyPoints) {
  const knownFields = Object.keys(def.fields).map(f => `- ${f} ("${def.fields[f]}"): currently ${JSON.stringify(record[f] ?? null)}`).join('\n');
  const body = (row.text_body || stripHtml(row.html_body || '')).slice(0, 6000);
  const pointsList = keyPoints && keyPoints.length ? keyPoints.map(p => `- ${p}`).join('\n') : '(none identified)';
  return `You are matching an inbound work email's already-identified key facts to a ${matchType} record's known fields, so a human can review and apply each match.

Key facts already identified in this email:
${pointsList}

Known fields on the matched record and their CURRENT saved values:
${knownFields}

For each key fact above that is specifically about one of the known fields' own information (not just loosely related), propose that field's new value using exactly what the fact already states - including a date the fact already gives (e.g. in parentheses), since that date IS the fact's stated value for that field, not something you're inferring. Only skip a field if none of the facts above are actually about it, or a fact is about it but states no value at all. Never invent a value no fact states.

Return ONLY a JSON object: { "changes": [ { "field": string (must be exactly one of the field names listed above), "proposed_value": string, "source_snippet": string (the EXACT sentence or phrase from the full email body below that supports this - copied verbatim from the body, not from the key facts list, not paraphrased) } ] }

Only include a field if the proposed value differs from its current value. Return { "changes": [] } if none of the key facts propose a real change.

Full email body (for finding the exact source_snippet only):
${body}`;
}

// Runs Phase 3 for one record on an already-matched, already-classified
// email. `overrideMatch` ({matchType, matchId}), when given, extracts
// against THAT record instead of the email's own primary match_type/
// match_id - lib/emailApply.js's resolveMatch uses this so an email
// genuinely about more than one record (e.g. one factory update covering
// two different styles) can be linked to each of them in turn, without one
// record's extraction clobbering another's.
//
// Safe to call more than once for the same (email, record) pair (e.g. from
// extractSweep after a process restart) - clears that record's own
// still-pending proposals on this email before inserting fresh ones,
// rather than accumulating duplicates or touching a DIFFERENT linked
// record's rows; a field a human already applied or declined is untouched
// (see status filter below), matching the "declined fields are marked
// declined, not deleted" rule from Phase 5 of the brief.
async function extractFieldChanges(resendEmailId, openaiClient, overrideMatch) {
  const row = db.prepare('SELECT * FROM inbound_emails WHERE resend_email_id = ?').get(resendEmailId);
  if (!row) return [];

  const matchType = overrideMatch ? overrideMatch.matchType : row.match_type;
  const matchId = overrideMatch ? overrideMatch.matchId : row.match_id;
  const def = matchType ? FIELD_DEFS[matchType] : null;
  const record = def ? getCurrentRecord(matchType, matchId) : null;

  let keyPoints = [];
  if (row.key_points_json) { try { keyPoints = JSON.parse(row.key_points_json); } catch (e) { keyPoints = []; } }

  let changes = [];
  if (def && record && openaiClient) {
    const prompt = buildPrompt(matchType, record, def, row, keyPoints);
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
    db.prepare(`DELETE FROM inbound_email_field_changes WHERE inbound_email_id = ? AND match_type = ? AND match_id = ? AND status = 'pending'`)
      .run(row.id, matchType, matchId);
    const insert = db.prepare(`
      INSERT INTO inbound_email_field_changes
        (inbound_email_id, match_type, match_id, field_name, field_label, current_value, proposed_value, source_snippet)
      VALUES (?,?,?,?,?,?,?,?)
    `);
    filtered.forEach(c => {
      insert.run(row.id, matchType, matchId, c.field, def.fields[c.field], record[c.field] ?? null, c.proposed_value.trim(), c.source_snippet || null);
    });
    db.prepare(`UPDATE inbound_emails SET extracted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(row.id);
  })();

  return filtered;
}

module.exports = { extractFieldChanges, FIELD_DEFS, getCurrentRecord };
