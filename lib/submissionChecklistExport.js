const ExcelJS = require('exceljs');
const { DOC_TYPES } = require('./finalSubmissionDocTypes');

// Renders the same checklist PnP's own "BULK SUBMISSION CHECKLIST" workbook
// captures (header fields + a tick against each required doc) - see
// public/final-submission/PnP BULK SUBMISSION CHECKLIST - LADIES.xlsx for
// the original this mirrors. `filled` is a Set of doc_type keys that
// currently have a row in order_submission_docs (see
// routes/finalSubmission.js), so the tick marks reflect live status rather
// than being hand-checked.
function buildChecklistWorkbook({ order, style, attn, filled }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Checklist');
  sheet.columns = [{ width: 28 }, { width: 30 }, { width: 12 }];

  const title = sheet.addRow(['BULK SUBMISSION CHECKLIST']);
  sheet.mergeCells(`A${title.number}:C${title.number}`);
  title.getCell(1).font = { bold: true, size: 14 };

  const headerField = (label, value) => {
    const row = sheet.addRow([label, value || '']);
    row.getCell(1).font = { bold: true };
  };
  headerField('ATT:', attn || '');
  headerField('STYLE NO:', order.style_no || (style && style.style_no) || '');
  headerField('ORDER NUMBER:', order.order_no || '');
  headerField('DESCRIPTION:', order.description || (style && style.description) || '');
  headerField('ART #:', order.rms_article_no || '');
  headerField('COLOUR:', order.colour || '');
  sheet.addRow([]);

  const tableHead = sheet.addRow(['Document', '', 'Status']);
  tableHead.getCell(1).font = { bold: true };
  tableHead.getCell(3).font = { bold: true };

  DOC_TYPES.forEach(dt => {
    const done = filled.has(dt.key);
    const row = sheet.addRow([dt.label, '', done ? '✓' : (dt.optional ? 'N/A' : '')]);
    row.getCell(3).font = { bold: true, color: { argb: done ? 'FF1A7F37' : 'FFAA0000' } };
    row.getCell(3).alignment = { horizontal: 'center' };
  });

  sheet.addRow([]);
  sheet.addRow(['Date submitted:', new Date().toISOString().slice(0, 10)]).getCell(1).font = { bold: true };

  return workbook;
}

module.exports = { buildChecklistWorkbook };
