const { LABELS } = require('./conceptCostingTranslate');

// Server-side twin of buildCostingEmailHtml in public/js/concepts.js - same
// table-based, fully inline-styled layout (no <style> block, no classes,
// for the same Gmail/Outlook paste-handler reasons as the client version),
// but for an actually-sent email: images are embedded as base64 data URIs
// directly in the HTML (via logoDataUrl / photos[].dataUrl, built by the
// caller - see routes/concepts.js), same technique the clipboard-paste
// version already uses client-side, rather than cid: attachments - simpler,
// and doesn't depend on Resend's attachment API supporting inline cid
// references (unconfirmed at the time this was written).

function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

const DENIM = '#2F4869';
const DENIM_DEEP = '#1F3350';
const STITCH_RED = '#A63A3A';
const INK = '#1C2126';
const INK_SOFT = '#4A5058';
const LINE = '#D8D6CE';
const LINE_SOFT = '#E8E7E0';

// Chinese column on hold for now (2026-08-06) - fieldRow/sectionHeading
// still take labelZh/valueZh (every call site below still passes them) but
// no longer render them, so a single-column English layout comes out
// without touching the ~20 call sites in buildCostingEmailHtml. The full
// two-column EN/ZH version is preserved commented out below each function -
// swap the early return for it (and restore full-width->50% on the English
// <td>) to bring Chinese back.
function fieldRow(labelEn, labelZh, valueEn, valueZh){
  if (!(valueEn != null && String(valueEn).trim())) return '';
  const en = escapeHtml(valueEn).replace(/\r?\n/g, '<br>');
  return `<tr>
    <td style="width:100%;padding:10px 0;border-bottom:1px solid ${LINE_SOFT};vertical-align:top;">
      <div style="font-size:9px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:${DENIM};margin:0 0 3px 0;">${escapeHtml(labelEn)}</div>
      <div style="font-size:13px;color:${INK};line-height:1.45;">${en}</div>
    </td>
  </tr>`;
  /*
  const zh = (valueZh != null && String(valueZh).trim()) ? escapeHtml(valueZh).replace(/\r?\n/g, '<br>') : '';
  return `<tr>
    <td style="width:50%;padding:10px 14px 10px 0;border-bottom:1px solid ${LINE_SOFT};vertical-align:top;">
      <div style="font-size:9px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:${DENIM};margin:0 0 3px 0;">${escapeHtml(labelEn)}</div>
      <div style="font-size:13px;color:${INK};line-height:1.45;">${en}</div>
    </td>
    <td style="width:50%;padding:10px 0 10px 14px;border-bottom:1px solid ${LINE_SOFT};border-left:1px solid ${LINE};vertical-align:top;">
      <div style="font-size:9px;font-weight:bold;color:${DENIM};margin:0 0 3px 0;">${escapeHtml(labelZh)}</div>
      <div style="font-size:13px;color:${INK};line-height:1.6;">${zh}</div>
    </td>
  </tr>`;
  */
}
function sectionHeading(labelEn, labelZh){
  return `<tr>
    <td style="padding:18px 0 6px 0;">
      <div style="font-size:12.5px;font-weight:bold;color:${DENIM_DEEP};">${escapeHtml(labelEn)}</div>
      <div style="border-bottom:2px solid ${STITCH_RED};width:28px;margin-top:5px;font-size:1px;line-height:1px;">&nbsp;</div>
    </td>
  </tr>`;
  /*
  return `<tr>
    <td colspan="2" style="padding:18px 0 6px 0;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="width:50%;">
          <div style="font-size:12.5px;font-weight:bold;color:${DENIM_DEEP};">${escapeHtml(labelEn)}</div>
          <div style="border-bottom:2px solid ${STITCH_RED};width:28px;margin-top:5px;font-size:1px;line-height:1px;">&nbsp;</div>
        </td>
        <td style="width:50%;padding-left:14px;">
          <div style="font-size:12.5px;font-weight:bold;color:${DENIM_DEEP};">${escapeHtml(labelZh)}</div>
          <div style="border-bottom:2px solid ${STITCH_RED};width:28px;margin-top:5px;font-size:1px;line-height:1px;">&nbsp;</div>
        </td>
      </tr></table>
    </td>
  </tr>`;
  */
}

// `photos` is [{ dataUrl }, ...] in display order - the caller
// (routes/concepts.js) owns reading concept_photos files off disk,
// converting them to PNG, and base64-encoding them.
function buildCostingEmailHtml({ concept: c, specPath, translations: t, logoDataUrl, photos }) {
  t = t || {};
  const title = `${c.concept_no} - Quotation Request`;
  // Chinese title line on hold for now (2026-08-06) - see fieldRow above.
  // const titleZh = `${c.concept_no} - ${LABELS.title.zh}`;
  const subtitle = [c.description, c.department, c.concept_date].filter(Boolean).join('  ·  ');

  const rows = [
    fieldRow(LABELS.shippingDate.en, LABELS.shippingDate.zh, c.shipping_date, c.shipping_date),
    fieldRow('Description', '款式描述', c.description, t.description),
    sectionHeading(LABELS.details.en, LABELS.details.zh),
    fieldRow(LABELS.fabricCode.en, LABELS.fabricCode.zh, c.fabric_code, c.fabric_code),
    fieldRow(LABELS.colour.en, LABELS.colour.zh, c.colour, t.colour),
    fieldRow(LABELS.wash.en, LABELS.wash.zh, c.wash, t.wash),
    fieldRow(LABELS.print.en, LABELS.print.zh, c.print, t.print),
    fieldRow(LABELS.embroidery.en, LABELS.embroidery.zh, c.embroidery_applique, t.embroidery_applique),
    fieldRow(LABELS.topstitching.en, LABELS.topstitching.zh, c.topstitching, t.topstitching),
    fieldRow(LABELS.trims.en, LABELS.trims.zh, c.trims, t.trims),
    fieldRow(LABELS.styling.en, LABELS.styling.zh, c.styling, t.styling),
    fieldRow(LABELS.units.en, LABELS.units.zh, c.units, c.units),
    fieldRow(LABELS.source.en, LABELS.source.zh, c.source, t.source),
    fieldRow(LABELS.packing.en, LABELS.packing.zh, c.packing, t.packing),
    fieldRow(LABELS.labels.en, LABELS.labels.zh, c.labels, t.labels),
    fieldRow(LABELS.spec.en, LABELS.spec.zh, specPath, t.specPath),
    sectionHeading(LABELS.costing.en, LABELS.costing.zh),
    fieldRow(LABELS.factoryTarget.en, LABELS.factoryTarget.zh, c.factory_target_price ? '$' + c.factory_target_price : '', c.factory_target_price ? '$' + c.factory_target_price : ''),
    fieldRow(LABELS.factoryQuoted.en, LABELS.factoryQuoted.zh, c.factory_price ? '$' + c.factory_price : '', c.factory_price ? '$' + c.factory_price : ''),
    fieldRow(LABELS.factoryOptions.en, LABELS.factoryOptions.zh, c.factory_cost_options, t.factory_cost_options),
  ].join('');

  const logoImg = logoDataUrl
    ? `<img src="${logoDataUrl}" height="34" style="display:block;border:0;" alt="Elanzas">`
    : `<div style="font-size:16px;font-weight:bold;letter-spacing:.08em;color:${DENIM_DEEP};">ELANZAS</div>`;

  const photoBlocksHtml = (photos || []).map((p, i) => {
    const capEn = `${LABELS.referencePhoto.en} ${i + 1} OF ${photos.length}`;
    // Chinese caption on hold for now (2026-08-06) - see fieldRow above.
    // const capZh = `${LABELS.referencePhoto.zh} ${i + 1}/${photos.length}`;
    return `<tr><td style="padding-top:16px;">
      <div style="font-size:9px;font-weight:bold;color:${DENIM};">${escapeHtml(capEn)}</div>
      <img src="${p.dataUrl}" style="max-width:660px;width:100%;height:auto;display:block;margin-top:6px;border:1px solid ${LINE};" alt="">
    </td></tr>`;
  }).join('');

  return `<table width="700" cellpadding="0" cellspacing="0" border="0" style="width:700px;max-width:100%;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">
    <tr>
      <td style="border-bottom:2px solid ${DENIM_DEEP};padding-bottom:12px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">${logoImg}</td>
          <td align="right" style="vertical-align:bottom;">
            <div style="font-size:16px;font-weight:bold;color:${DENIM_DEEP};">${escapeHtml(title)}</div>
            ${subtitle ? `<div style="font-size:10.5px;color:${INK_SOFT};margin-top:4px;">${escapeHtml(subtitle)}</div>` : ''}
          </td>
        </tr></table>
      </td>
    </tr>
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr>
    ${photoBlocksHtml}
    <tr><td style="border-top:1px solid ${LINE};padding-top:10px;">
      <div style="font-size:9.5px;color:${INK_SOFT};">Elanzas &middot; Quotation Request</div>
    </td></tr>
  </table>`;
}

// Plain-text multipart/alternative fallback for mail clients that don't
// render HTML - English only (unlike the HTML version) since a factory
// contact capable of reading the bilingual HTML table will get it; this is
// just the safety net for clients that strip HTML entirely.
function buildCostingPlainText(concept, specPath) {
  const c = concept;
  const field = (label, value) => (value != null && String(value).trim()) ? [`${label}: ${value}`] : [];
  return [
    'QUOTATION REQUEST',
    `Concept: ${c.concept_no} - ${c.description || ''}`,
    ...field('Shipping Date', c.shipping_date),
    '',
    'DETAILS',
    ...field('Fabric code', c.fabric_code),
    ...field('Colour', c.colour),
    ...field('Wash', c.wash),
    ...field('Print', c.print),
    ...field('Embroidery/Applique', c.embroidery_applique),
    ...field('Topstitching', c.topstitching),
    ...field('Trims', c.trims),
    ...field('Styling', c.styling),
    ...field('Units', c.units),
    ...field('Source', c.source),
    ...field('Packing', c.packing),
    ...field('Labels', c.labels),
    ...(specPath ? field('Spec / Measurements', specPath) : []),
    '',
    'QUOTATION',
    ...field('Factory Target $ Price', c.factory_target_price ? '$' + c.factory_target_price : ''),
    ...field('Factory $ Price (quoted)', c.factory_price ? '$' + c.factory_price : ''),
    ...(c.factory_cost_options ? ['', 'Factory cost options / alternatives:', c.factory_cost_options] : []),
  ].join('\n');
}

module.exports = { buildCostingEmailHtml, buildCostingPlainText };
