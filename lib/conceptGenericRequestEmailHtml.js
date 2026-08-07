const { REQUEST_TYPES } = require('./conceptCostingTranslate');

// Twin of lib/conceptCostingEmailHtml.js for the non-cost request types
// (sample / PP sample / bulk sample / fabric test - see REQUEST_TYPES) -
// same letterhead and brand palette, but the body is just the free-text
// message the user typed (translated) plus photos, since none of these
// types have a fixed structured field set the way costing does. Also
// builds the manual reminder email (see routes/requests.js's remind route).

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

function typeLabelFor(requestType) {
  return REQUEST_TYPES[requestType] || REQUEST_TYPES.sample;
}

// Chinese on hold for now (2026-08-06) - letterheadHtml/footerHtml still
// accept titleZh/zhBrand (every call site below still passes them) but no
// longer render them, so callers didn't need to change. See each caller
// below for the original bilingual title/body lines, preserved commented out.
function letterheadHtml({ title, titleZh, subtitle, logoDataUrl }) {
  const logoImg = logoDataUrl
    ? `<img src="${logoDataUrl}" height="34" style="display:block;border:0;" alt="Elanzas">`
    : `<div style="font-size:16px;font-weight:bold;letter-spacing:.08em;color:${DENIM_DEEP};">ELANZAS</div>`;
  return `<tr>
    <td style="border-bottom:2px solid ${DENIM_DEEP};padding-bottom:12px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:middle;">${logoImg}</td>
        <td align="right" style="vertical-align:bottom;">
          <div style="font-size:16px;font-weight:bold;color:${DENIM_DEEP};">${escapeHtml(title)}</div>
          ${subtitle ? `<div style="font-size:10.5px;color:${INK_SOFT};margin-top:4px;">${escapeHtml(subtitle)}</div>` : ''}
        </td>
      </tr></table>
    </td>
  </tr>`;
  /* bilingual version - restore the titleZh line between title and subtitle:
  <div style="font-size:13px;color:${DENIM_DEEP};margin-top:2px;">${escapeHtml(titleZh)}</div>
  */
}
function footerHtml(zhBrand) {
  return `<tr><td style="border-top:1px solid ${LINE};padding-top:10px;">
    <div style="font-size:9.5px;color:${INK_SOFT};">Elanzas</div>
  </td></tr>`;
  /* bilingual version:
  <div style="font-size:9.5px;color:${INK_SOFT};">Elanzas${zhBrand ? ` &middot; Elanzas &middot; ${escapeHtml(zhBrand)}` : ''}</div>
  */
}

// `photos` is [{ dataUrl }, ...] - same shape/convention as
// lib/conceptCostingEmailHtml.js's photo blocks.
function buildGenericRequestEmailHtml({ concept: c, requestType, message, messageZh, logoDataUrl, photos }) {
  const typeLabel = typeLabelFor(requestType);
  const title = `${c.concept_no} - ${typeLabel.en}`;
  const subtitle = [c.description, c.department].filter(Boolean).join('  ·  ');
  const msgEn = escapeHtml(message).replace(/\r?\n/g, '<br>');

  const photoBlocksHtml = (photos || []).map((p, i) => {
    const capEn = `REFERENCE PHOTO ${i + 1} OF ${photos.length}`;
    return `<tr><td style="padding-top:16px;">
      <div style="font-size:9px;font-weight:bold;color:${DENIM};">${escapeHtml(capEn)}</div>
      <img src="${p.dataUrl}" style="max-width:660px;width:100%;height:auto;display:block;margin-top:6px;border:1px solid ${LINE};" alt="">
    </td></tr>`;
  }).join('');

  return `<table width="700" cellpadding="0" cellspacing="0" border="0" style="width:700px;max-width:100%;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">
    ${letterheadHtml({ title, subtitle, logoDataUrl })}
    <tr><td style="padding-top:16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="width:100%;vertical-align:top;">
          <div style="font-size:13px;color:${INK};line-height:1.6;white-space:pre-wrap;">${msgEn}</div>
        </td>
      </tr></table>
    </td></tr>
    ${photoBlocksHtml}
    ${footerHtml()}
  </table>`;
  /* bilingual version (Chinese title/caption/message column on hold for now,
     2026-08-06) - restore:
     - titleZh = `${c.concept_no} - ${typeLabel.zh}`, passed to letterheadHtml
     - capZh = `参考图片 ${i + 1}/${photos.length}` per photo, appended to the caption div
     - msgZh = (messageZh || '').trim() ? escapeHtml(messageZh).replace(/\r?\n/g, '<br>') : ''
     - the message row's single 100%-width <td> back to two 50%-width <td>s (En/Zh, border-left divider)
     - footerHtml(typeLabel.zh) instead of footerHtml()
  */
}

function buildGenericRequestPlainText({ concept: c, requestType, message }) {
  const typeLabel = typeLabelFor(requestType);
  return [
    typeLabel.en.toUpperCase(),
    `Concept: ${c.concept_no} - ${c.description || ''}`,
    '',
    message || '',
  ].join('\n');
}

// Fixed hand-written bilingual template rather than an AI call - the
// wording is always the same shape (only the type name, subject and date
// vary), so there's no free text here that actually needs translating, and
// a reminder should go out instantly without depending on OpenAI being
// configured.
function buildReminderEmailHtml({ concept: c, requestType, originalSubject, originalDate, logoDataUrl }) {
  const typeLabel = typeLabelFor(requestType);
  const title = `${c.concept_no} - Reminder`;
  const bodyEn = `Following up on our ${typeLabel.en.toLowerCase()} sent on ${originalDate} ("${originalSubject}") - we haven't heard back yet and would appreciate an update when you have a chance. Thank you!`;
  return `<table width="700" cellpadding="0" cellspacing="0" border="0" style="width:700px;max-width:100%;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">
    ${letterheadHtml({ title, subtitle: c.description, logoDataUrl })}
    <tr><td style="padding-top:16px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="width:100%;vertical-align:top;">
          <div style="font-size:13px;color:${INK};line-height:1.6;">${escapeHtml(bodyEn)}</div>
        </td>
      </tr></table>
    </td></tr>
    ${footerHtml()}
  </table>`;
  /* bilingual version (Chinese title/body column on hold for now,
     2026-08-06) - this was hand-written, not from the AI translation call,
     so disabling translateMessage in lib/conceptCostingTranslate.js never
     touched it. Restore:
     - titleZh = `${c.concept_no} - 提醒`, passed to letterheadHtml
     - bodyZh = `关于我们于 ${originalDate} 发送的${typeLabel.zh}（"${escapeHtml(originalSubject)}"）的跟进 - 我们目前还未收到回复，如方便请提供最新进展，谢谢！`
     - the body row's single 100%-width <td> back to two 50%-width <td>s (En/Zh, border-left divider)
     - footerHtml('提醒') instead of footerHtml()
  */
}
function buildReminderPlainText({ concept: c, requestType, originalSubject, originalDate }) {
  const typeLabel = typeLabelFor(requestType);
  return `REMINDER\nConcept: ${c.concept_no} - ${c.description || ''}\n\nFollowing up on our ${typeLabel.en.toLowerCase()} sent on ${originalDate} ("${originalSubject}") - we haven't heard back yet and would appreciate an update when you have a chance. Thank you!`;
}

module.exports = { buildGenericRequestEmailHtml, buildGenericRequestPlainText, buildReminderEmailHtml, buildReminderPlainText };
