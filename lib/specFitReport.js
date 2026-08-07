const { PDFParse } = require('pdf-parse');
const ExcelJS = require('exceljs');

// Fit/appraisal sheets come back from the factory in whatever format they
// were sent out in - a filled copy of the buyer's own Excel template, or a
// scan/export to PDF - and every buyer's template lays its columns out
// differently. Rather than hand-mapping cell positions to one specific
// layout (fragile - breaks on the next buyer's sheet), both formats are
// reduced to plain text and read by the same AI prompt, constrained to only
// return values against this style's own known point-of-measure names -
// same "let an LLM generalize across formats" approach already used for
// fabric lab reports (see lib/fabricTestReport.js).

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// Flattens every populated cell, sheet by sheet, into a simple row-per-line
// text dump ("A: WAISTBAND DEPTH | B: 0.0 | C: 0.0 ...") - not trying to
// preserve the visual grid, just giving the AI every value with something
// to anchor it to a row.
async function extractXlsxText(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const lines = [];
  workbook.eachSheet(sheet => {
    lines.push(`--- Sheet: ${sheet.name} ---`);
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells = [];
      row.eachCell({ includeEmpty: false }, cell => {
        const v = cell.value && cell.value.richText
          ? cell.value.richText.map(t => t.text).join('')
          : cell.value;
        const text = (v == null) ? '' : String(v).trim();
        if (text) cells.push(text);
      });
      if (cells.length) lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

function buildExtractionPrompt(pomNames, rawText) {
  return `You are reading a garment fit/appraisal report and extracting the ACTUAL MEASURED values (not the target/spec values) for a specific list of points of measure.

Only return values for point-of-measure names from this exact list (use the exact spelling given here as the JSON key - do not invent, rename, or abbreviate):
${pomNames.map(n => `- ${n}`).join('\n')}

Return ONLY a JSON object with this shape:
{
  "fit_date": string (YYYY-MM-DD) or null - the date this fit/appraisal was done, if stated,
  "values": { "<exact point-of-measure name from the list above>": "<actual measured value as text>", ... }
}

Notes:
- A report often has multiple value columns per row (e.g. "Actual Sample", "In Measure", "Spec To Be") - use only the ACTUAL/MEASURED column, never the target/spec-to-be column.
- Only include a key in "values" for a point of measure you actually found a measured value for - omit anything not present, don't guess or use 0.
- Match point-of-measure names loosely (ignore case, punctuation, and minor wording differences) but always key the result using the exact name as written in the list above.

Raw text:
${rawText.slice(0, 15000)}`;
}

async function runExtraction(rawText, openaiClient, pomNames) {
  if (!openaiClient) throw new Error('OPENAI_API_KEY is not set on the server (.env)');
  if (!rawText || !rawText.trim()) throw new Error('No readable content found in that file');

  const res = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [{ role: 'user', content: buildExtractionPrompt(pomNames, rawText) }],
    response_format: { type: 'json_object' }
  });

  let parsed;
  try {
    parsed = JSON.parse(res.choices[0].message.content);
  } catch (e) {
    throw new Error('Could not parse the extracted data - the sheet format may be unusual');
  }
  return { fit_date: parsed.fit_date || null, values: parsed.values || {} };
}

async function extractSpecFitFromPdf(buffer, openaiClient, pomNames) {
  let text;
  try {
    text = await extractPdfText(buffer);
  } catch (e) {
    throw new Error('Could not read that PDF - it may be corrupt or password-protected: ' + e.message);
  }
  if (!text || !text.trim()) {
    throw new Error('No readable text found in that PDF - it may be a scanned image rather than a real document');
  }
  return runExtraction(text, openaiClient, pomNames);
}

async function extractSpecFitFromXlsx(buffer, openaiClient, pomNames) {
  let text;
  try {
    text = await extractXlsxText(buffer);
  } catch (e) {
    throw new Error('Could not read that spreadsheet - it may be corrupt or in an unsupported format: ' + e.message);
  }
  return runExtraction(text, openaiClient, pomNames);
}

module.exports = { extractSpecFitFromPdf, extractSpecFitFromXlsx };
