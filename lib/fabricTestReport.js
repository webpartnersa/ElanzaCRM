const { PDFParse } = require('pdf-parse');

// Fabric lab test reports come from many different labs (NQA, CTI, SGS,
// Intertek...) with different layouts, so a fixed regex parser would break
// on the next unfamiliar format. Instead: pull the raw text out with
// pdf-parse (reliable - these reports are real embedded text, not scans),
// then let an LLM read that text and pull out the fields, which generalizes
// across formats without hand-written per-lab parsing rules.
const EXTRACTION_PROMPT = `You are extracting structured data from a fabric lab test report (from any testing lab - NQA, CTI, SGS, Intertek, Bureau Veritas, etc - formats vary). Read the raw text below and return ONLY a JSON object with these exact keys (use null for anything not present in the text - do not guess or invent values):
{
  "fabric_code": string or null,
  "report_number": string or null,
  "style_no": string or null,
  "end_buyer": string or null,
  "sample_description": string or null,
  "report_date": string (YYYY-MM-DD) or null,
  "weight_gsm": string or null (numeric grams per square meter only, e.g. "377" - no units in the value),
  "composition": string or null (e.g. "39.4% Viscose, 35.5% Polyester, 25.1% Cotton"),
  "overall_result": string or null (a short pass/fail/summary of the conclusions section)
}

Notes:
- fabric_code is usually NOT its own labeled field - it's typically embedded
  inside the free-text "Sample Description", often as a short alphanumeric
  code near the end (e.g. "...for girls denim jacket/pants/cd154." -> fabric
  code is "cd154"). Look for a short code-like token (letters+digits, no
  spaces) near the end of the sample description and extract it separately
  as fabric_code, in addition to returning the full sample_description text
  unmodified. If nothing like that is present, use null - don't invent one.

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

// Returns the extracted fields, or throws with a clean message the route
// can surface directly - callers don't need to know whether the failure
// was a bad PDF, a missing API key, or a malformed AI response.
async function extractFabricTestReport(buffer, openaiClient) {
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

  let fields;
  try {
    fields = JSON.parse(res.choices[0].message.content);
  } catch (e) {
    throw new Error('Could not parse the extracted data - the report format may be unusual');
  }
  return fields;
}

module.exports = { extractFabricTestReport, extractPdfText };
