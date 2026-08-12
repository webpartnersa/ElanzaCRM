const { db } = require('../db');

// Very small text-similarity scorer - counts shared significant words
// (3+ chars) between two strings, case-insensitive. There's no hard link
// between "this document's Older Boys variant" and "that Older Boys
// order" (worksheets/POs don't reference Elanzas' own order ids), so this
// is only ever used to rank suggestions - the user always confirms before
// anything actually gets applied to another order.
function wordOverlapScore(a, b) {
  const words = s => (s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const wa = new Set(words(a));
  const wb = words(b);
  let score = 0;
  wb.forEach(w => { if (wa.has(w)) score++; });
  return score;
}

// The variant that belongs to the order actually being uploaded to -
// matched by department against that order's own style; falls back to the
// first variant if nothing matches (some variant has to apply directly to
// the order the file was uploaded on, even if the department guess missed).
function pickSelfVariant(variants, department) {
  if (!variants || !variants.length) return null;
  return variants.find(v => v.department_guess === department) || variants[0];
}

// For every OTHER variant in the document, finds candidate sibling orders
// (same department, ranked by how much their style/order description
// overlaps with the variant's own label) that this document might also
// apply to. Read-only - callers show these as suggestions.
function findSiblingCandidates(variants, selfVariant, excludeOrderId) {
  const others = (variants || []).filter(v => v !== selfVariant);
  return others.map(variant => {
    if (!variant.department_guess) return { variant, candidates: [] };
    const rows = db.prepare(`
      SELECT o.*, s.department AS style_department, s.description AS style_description
      FROM orders o
      LEFT JOIN styles s ON s.id = o.style_id
      WHERE o.id != ? AND s.department = ?
      ORDER BY o.created_at DESC
    `).all(excludeOrderId, variant.department_guess);
    const candidates = rows
      .map(o => ({ order: o, score: wordOverlapScore(variant.label, o.description || o.style_description || '') }))
      .sort((a, b) => b.score - a.score)
      .map(x => x.order);
    return { variant, candidates };
  });
}

module.exports = { pickSelfVariant, findSiblingCandidates, wordOverlapScore };
