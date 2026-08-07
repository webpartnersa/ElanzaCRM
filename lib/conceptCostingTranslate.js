// Simplified Chinese for the costing request emailed to a factory in China
// (see /api/concepts/:id/costing-email-data and public/js/concepts.js's
// buildCostingEmailHtml). Static UI labels (fixed, small set) get a
// hand-written translation once here - fast, free, consistent every time.
// The concept's own free-text field VALUES vary per concept and can't be
// pre-written, so those go through a single batched AI translation call.

// Garment-trade terminology where it differs from a literal translation
// (e.g. "船期"/"出货日期" for shipping date, "面料编号" for fabric code) -
// chosen to read naturally to a factory merchandiser, not a dictionary
// translation.
// Chinese values on hold for now (2026-08-06) - none of the email builders
// read .zh anymore (see lib/conceptCostingEmailHtml.js and
// lib/conceptGenericRequestEmailHtml.js), so these are inert until then.
// Kept commented in place per label rather than deleted, so re-enabling is
// just uncommenting.
const LABELS = {
  title: { en: 'QUOTATION REQUEST' /* zh: '询价单' */ },
  shippingDate: { en: 'Shipping Date' /* zh: '出货日期' */ },
  details: { en: 'DETAILS' /* zh: '款式详情' */ },
  fabricCode: { en: 'Fabric code' /* zh: '面料编号' */ },
  colour: { en: 'Colour' /* zh: '颜色' */ },
  wash: { en: 'Wash' /* zh: '水洗' */ },
  print: { en: 'Print' /* zh: '印花' */ },
  embroidery: { en: 'Embroidery / Applique' /* zh: '刺绣 / 贴布绣' */ },
  topstitching: { en: 'Topstitching' /* zh: '明线' */ },
  trims: { en: 'Trims' /* zh: '辅料' */ },
  styling: { en: 'Styling' /* zh: '款式说明' */ },
  units: { en: 'Units' /* zh: '数量' */ },
  source: { en: 'Source' /* zh: '来源' */ },
  packing: { en: 'Packing' /* zh: '包装' */ },
  labels: { en: 'Labels' /* zh: '标签' */ },
  spec: { en: 'Spec / Measurements' /* zh: '规格 / 尺寸' */ },
  costing: { en: 'QUOTATION' /* zh: '报价' */ },
  factoryTarget: { en: 'Factory Target $ Price' /* zh: '工厂目标价格（美元）' */ },
  factoryQuoted: { en: 'Factory $ Price (quoted)' /* zh: '工厂报价（美元）' */ },
  factoryOptions: { en: 'Factory cost options / alternatives' /* zh: '工厂备选方案 / 其他报价' */ },
  referencePhoto: { en: 'REFERENCE PHOTO' /* zh: '参考图片' */ },
};

// The fixed set of factory communication types this app can send - see
// concept_requests.request_type in db.js and routes/requests.js's
// send-request route. 'cost' is the original type (rich, built from the
// concept's own Details/Costing fields via buildCostingEmailHtml); the rest
// are free-text (the user types the message, see buildGenericRequestEmailHtml
// in lib/conceptGenericRequestEmailHtml.js) since none of them have
// dedicated structured fields elsewhere in the app the way costing does.
// Chinese values on hold for now (2026-08-06) - see LABELS above.
const REQUEST_TYPES = {
  cost: { en: 'Costing Request' /* zh: '询价单' */ },
  sample: { en: 'Sample Request' /* zh: '样品申请' */ },
  pp_sample: { en: 'PP Sample Request' /* zh: 'PP样衣申请' */ },
  bulk_sample: { en: 'Bulk Sample Request' /* zh: '大货样衣申请' */ },
  fabric_test: { en: 'Fabric Test Report Request' /* zh: '面料测试报告申请' */ },
};

// Which concept fields actually need AI translation - the free-text ones a
// merchandiser typed by hand. Fixed-vocabulary fields (dates, money
// amounts) don't need it.
const TRANSLATABLE_FIELDS = [
  'description', 'colour', 'wash', 'print', 'embroidery_applique',
  'topstitching', 'trims', 'styling', 'source', 'packing', 'labels',
  'factory_cost_options'
];

const TRANSLATION_PROMPT = `You are translating fields from a garment costing request into Simplified Chinese, for a factory merchandiser in China to read. Use natural garment-industry terminology, not literal dictionary translation. Keep it concise - match the register of the English (short spec notes, not full sentences, unless the English itself is a full sentence).

Return ONLY a JSON object mapping each input key to its Chinese translation, e.g. {"colour": "深色"}. Only include keys that were given text to translate - omit anything you were given as empty.

Fields to translate:
`;

// On hold for now (2026-08-06) - AI translation of free-text field values is
// disabled below, uncomment to bring it back. Static labels (LABELS/
// REQUEST_TYPES above) still render in both languages either way, so emails
// stay bilingual-shelled, just with blank Chinese cells where a translated
// value would have gone - same as what already happens today with no
// OPENAI_API_KEY configured.
async function translateConceptFields(fields, openaiClient) {
  return {};
  /*
  const toTranslate = {};
  TRANSLATABLE_FIELDS.forEach(key => {
    const v = fields[key];
    if (v != null && String(v).trim()) toTranslate[key] = String(v).trim();
  });
  // specPath is passed separately since it's not a raw concept column.
  if (fields.specPath) toTranslate.specPath = fields.specPath;

  if (!Object.keys(toTranslate).length) return {};
  if (!openaiClient) return {}; // no API key configured - PDF still works, just English-only

  try {
    const res = await openaiClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: TRANSLATION_PROMPT + JSON.stringify(toTranslate, null, 2) }],
      response_format: { type: 'json_object' }
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.error('Costing request translation failed:', e.message);
    return {}; // a failed translation shouldn't block the English PDF from generating
  }
  */
}

// One free-text message translated to Chinese - used for the non-cost
// request types (see lib/conceptGenericRequestEmailHtml.js) and for
// reminder follow-ups, neither of which have a fixed field set to run
// through translateConceptFields above.
// On hold for now (2026-08-06) - see translateConceptFields above.
async function translateMessage(text, openaiClient) {
  return '';
  /*
  if (!text || !text.trim()) return '';
  if (!openaiClient) return '';
  try {
    const res = await openaiClient.chat.completions.create({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: `Translate the following message from a garment merchandiser to a factory in China into natural Simplified Chinese, suitable for a factory merchandiser to read. Use garment-industry terminology where relevant, not literal dictionary translation. Reply with ONLY the translated text - no explanation, no quotes.\n\n${text.trim()}` }],
    });
    return (res.choices[0].message.content || '').trim();
  } catch (e) {
    console.error('Message translation failed:', e.message);
    return ''; // a failed translation shouldn't block the English email from sending
  }
  */
}

module.exports = { LABELS, REQUEST_TYPES, translateConceptFields, translateMessage };
