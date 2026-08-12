const { PDFParse } = require('pdf-parse');

// Worksheets and POs both come from the buyer in whatever layout their own
// system produces (and can differ retailer to retailer), so - same
// reasoning as fabricTestReport.js - a fixed positional parser would break
// on the next format. One shared prompt handles both document kinds: a
// worksheet and its resulting PO describe the same thing (one or more
// department "variants" of a style, each with its own units/price/delivery
// date), just at different stages, so the target shape is identical.
const DEPARTMENTS = ['Ladies', 'Mens', 'Younger Boys', 'Older Boys', 'Younger Girls', 'Older Girls', 'Babywear'];

const EXTRACTION_PROMPT = `You are extracting structured data from a clothing retailer's order document - either a buyer's "worksheet" (a pro-forma order/brief) or a formal "Purchase Order" (PO). Layouts vary by retailer. Read the raw text below and return ONLY a JSON object with this exact shape (use null for anything not present - do not guess or invent values):
{
  "document_number": string or null (the worksheet number, SAP number, or PO number - whichever identifies this specific document),
  "variants": [
    {
      "label": string (the exact product/brand/description text identifying this variant, e.g. "REAL YB RUGBY FLEECE MULTI" or "YB RUGBY FLEECE"),
      "department_guess": one of ${JSON.stringify(DEPARTMENTS)}, or null if you can't tell,
      "units": number or null (the TOTAL unit quantity for this variant across all its sizes - not a carton count, not a single size's quantity),
      "unit_price": number or null (the per-unit COST price the factory/supplier charges, INCLUDING any duties/VAT if the document distinguishes - look for labels like "Cost Price Incl", "Unit Cost", "Landed Cost" - never the retail/selling price),
      "delivery_date": string (YYYY-MM-DD) or null (this variant's delivery/DC date - if the whole document has one shared delivery date rather than a per-variant one, use that same date for every variant)
    }
  ]
}

Notes:
- A single document can describe MULTIPLE variants (e.g. one PO covering both a "Younger Boys" and an "Older Boys" version of the same base garment, each with its own colour/units/price) - return one array entry per variant, not just the first one found.
- department_guess: use common retail age-band/department abbreviations as strong hints - "YB"/"Younger Boys"/"Boys A" typically mean Younger Boys, "OB"/"Older Boys"/"Boys B" mean Older Boys, "YG"/"Girls A" mean Younger Girls, "OG"/"Girls B" mean Older Girls, "Baby"/"Infant" means Babywear, plain "Boys"/"Girls" with no age split should map to whichever of the two boy/girl departments the surrounding context (age ranges, sizing) best fits, or null if genuinely ambiguous.
- units: on a PO, this is usually a "Total Qty" figure tied to the variant's own fabric/packing line, not the header "OrderQty"/carton count field - sum multiple size lines if that's the only way to get a true total. On a worksheet, there is often a "SIZES RATIO / QUANTITY / %" breakdown table whose row also ends in a "Total" - that total is just the size-ratio's own small proportional sum (e.g. "16"), NOT the real unit quantity, and must be ignored for this field. The real total (often much larger, e.g. "3,300") appears separately, usually near a "TOTAL UNITS", "UNITS DELIVERY", or "UNITS & COLOUR" label - use that one.
- If the same field appears at both document-level and variant-level (e.g. one delivery date for the whole document), apply it to every variant.
- delivery_date: a worksheet or PO often lists more than one date (brief date, ship date, delivery date, deadlines) - use the one labeled "Delivery Date" / "First Delivery Date" / "DC Date" specifically (the date goods are due at the retailer's distribution centre), not a ship date, brief date, or any fit/seal deadline. The delivery date is normally the LATEST of the dates present, since goods ship before they're delivered.
- PDF text extraction can jumble table layouts so a label and its value end up far apart in the raw text below, or a value appears before its label - read the whole text for every field rather than assuming a label's value sits immediately next to it.

Raw text:
`;

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Returns { document_number, variants: [...] }, or throws with a clean
// message the route can surface directly.
async function extractOrderDoc(buffer, openaiClient) {
  if (!openaiClient) throw new Error('OPENAI_API_KEY is not set on the server (.env)');

  let text;
  try {
    text = await extractPdfText(buffer);
  } catch (e) {
    throw new Error('Could not read that PDF - it may be corrupt or password-protected: ' + e.message);
  }
  if (!text || !text.trim()) {
    throw new Error('No readable text found in that PDF - it may be a scanned image rather than a real document');
  }

  const res = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: EXTRACTION_PROMPT + text.slice(0, 15000) }],
    response_format: { type: 'json_object' }
  });

  let data;
  try {
    data = JSON.parse(res.choices[0].message.content);
  } catch (e) {
    throw new Error('Could not parse the extracted data - the document format may be unusual');
  }
  if (!data || !Array.isArray(data.variants)) data = { document_number: data && data.document_number || null, variants: [] };
  return data;
}

module.exports = { extractOrderDoc, extractPdfText, DEPARTMENTS };
