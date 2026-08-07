const path = require('path');
const ExcelJS = require('exceljs');

// Fills the buyer's own "Sample Appraisal Report" template (the real file
// this style's spec category was seeded from - see db.js/spec_category_poms)
// with this style's actual recorded fit values, rather than recreating the
// layout from scratch - loading the real workbook and only writing into its
// known-blank input cells guarantees the export keeps the buyer's exact
// fonts, colours, merges, column widths and the (currently unused) GRADED
// SPEC sheet, not just an approximation of them.
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'pnp-denim-short-appraisal.xlsx');
const SHEET_NAME = 'DENIM SHORTS';

// First data row of the 27-row POINT OF MEASURE table (C14:F14 is the first
// POM name cell) - see the template itself for the fixed row layout below
// this: G/H/I = 1st fit actual/PnP-measure/spec-to-be, J/K/L = 2nd fit,
// M/N/O = seal-pps, all per row.
const POM_FIRST_ROW = 14;
const POM_MAX_ROWS = 27;
const STAGE_COLS = { '1st_fit': ['G', 'H', 'I'], '2nd_fit': ['J', 'K', 'L'], seal_pps: ['M', 'N', 'O'] };
const STAGE_DATE_CELLS = { '1st_fit': 'G11', '2nd_fit': 'J11', seal_pps: 'M11' };

function setCell(sheet, address, value) {
  sheet.getCell(address).value = value || '';
}

async function buildAppraisalWorkbook({ style, category, poms, fits }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);
  const sheet = workbook.getWorksheet(SHEET_NAME);

  setCell(sheet, 'N2', style.style_no);
  setCell(sheet, 'E3', style.retailer);
  setCell(sheet, 'E4', style.first_delivery || style.first_ship);
  setCell(sheet, 'E5', style.description);
  setCell(sheet, 'E6', [style.composition, style.weight].filter(Boolean).join(' / '));
  setCell(sheet, 'L6', style.units);
  setCell(sheet, 'E8', style.buyer);
  setCell(sheet, 'E9', style.factory);

  Object.entries(STAGE_DATE_CELLS).forEach(([stage, address]) => {
    const fit = fits[stage];
    setCell(sheet, address, fit ? fit.fit_date : '');
  });

  poms.slice(0, POM_MAX_ROWS).forEach((p, i) => {
    const row = POM_FIRST_ROW + i;
    setCell(sheet, `C${row}`, p.name);
    Object.entries(STAGE_COLS).forEach(([stage, [actualCol, , specCol]]) => {
      const fit = fits[stage];
      const actual = fit && fit.values ? fit.values[p.id] : '';
      setCell(sheet, `${actualCol}${row}`, actual);
      setCell(sheet, `${specCol}${row}`, p.spec_to_be);
    });
  });
  // Blank out any template rows this style's own bank doesn't use (e.g. a
  // shorter measurement sheet than the standard 27 points of measure).
  for (let i = poms.length; i < POM_MAX_ROWS; i++) {
    const row = POM_FIRST_ROW + i;
    setCell(sheet, `C${row}`, '');
  }

  setCell(sheet, 'E42', category ? category.name : '');

  const notes = ['1st_fit', '2nd_fit', 'seal_pps']
    .map(stage => (fits[stage] && fits[stage].notes ? `${stage.replace('_', ' ').toUpperCase()}: ${fits[stage].notes}` : null))
    .filter(Boolean);
  if (notes.length) setCell(sheet, 'F48', notes.join('\n'));

  return workbook;
}

module.exports = { buildAppraisalWorkbook };
