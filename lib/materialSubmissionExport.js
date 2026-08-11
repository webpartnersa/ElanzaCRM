const ExcelJS = require('exceljs');

// Builds PnP's "Material Submission form" (see public/final-submission/PnP
// Material submission V1.0.pdf for the original) from scratch with ExcelJS,
// rather than filling a buyer-supplied template like
// lib/specAppraisalExport.js does - PnP only ever gave us a filled PDF
// example, not a blank fillable workbook, so there's no template to load.
// Field values come from three places, matching how the form itself groups
// them: fabric-level detail (type/construction/yarn breakdown/suppliers)
// from the fabrics table (see db.js's fabrics migration - already
// structured to match this form 1:1), style/order detail from the order
// itself, and Garment Manufacturer from the factories table.

const LABEL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const THIN_BORDER = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const BORDER_ALL = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function labelRow(sheet, label, value) {
  const row = sheet.addRow([label, value || '']);
  row.getCell(1).font = { bold: true, size: 10 };
  row.getCell(1).fill = LABEL_FILL;
  row.getCell(1).alignment = { vertical: 'middle', wrapText: true };
  row.getCell(2).alignment = { vertical: 'middle', wrapText: true };
  row.eachCell(c => { c.border = BORDER_ALL; });
  return row;
}

function sectionHeader(sheet, title) {
  const row = sheet.addRow([title]);
  sheet.mergeCells(`A${row.number}:E${row.number}`);
  row.getCell(1).font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF444444' } };
  row.getCell(1).alignment = { vertical: 'middle' };
  row.height = 20;
  return row;
}

function buildMaterialSubmissionWorkbook({ order, style, fabric, factory }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Material Submission', {
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1 }
  });
  sheet.columns = [
    { width: 40 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }
  ];

  const title = sheet.addRow(['Material Submission form']);
  sheet.mergeCells(`A${title.number}:E${title.number}`);
  title.getCell(1).font = { bold: true, size: 16 };
  title.height = 26;
  sheet.addRow([]);

  sectionHeader(sheet, 'FABRIC DETAIL');
  labelRow(sheet, 'Fabric quality reference / ID', fabric ? fabric.code : '');
  labelRow(sheet, 'Fabric description (incl. comp and yarn count)', fabric ? fabric.description : '');
  labelRow(sheet, 'Fabric composition %', fabric ? fabric.composition : '');
  labelRow(sheet, 'Fabric weight in g/m²', fabric ? fabric.weight : '');
  labelRow(sheet, 'Fabric type (knit, woven)', fabric ? fabric.fabric_type : '');
  labelRow(sheet, 'Fabric construction (voile, poplin, rib, single jersey, twill...)', fabric ? fabric.construction : '');
  labelRow(sheet, 'Construction gauge (warp x weft / courses x wales per inch)', fabric ? fabric.construction_gauge : '');
  labelRow(sheet, 'Fabric finishes and processing', fabric ? fabric.finishes : '');
  sheet.addRow([]);

  sectionHeader(sheet, 'YARN DETAIL');
  const yarnHeadRow = sheet.addRow(['', 'Yarn 1', 'Yarn 2', 'Yarn 3', 'Yarn 4']);
  yarnHeadRow.eachCell(c => { c.font = { bold: true }; c.border = BORDER_ALL; c.fill = LABEL_FILL; });
  const yarnAttrs = [
    ['count', 'Yarn count'],
    ['composition', 'Yarn composition'],
    ['spinning', 'Yarn spinning'],
    ['type', 'Yarn type'],
    ['sustainability', 'Yarn sustainability'],
  ];
  yarnAttrs.forEach(([attr, label]) => {
    const row = sheet.addRow([
      label,
      fabric ? fabric[`yarn1_${attr}`] || '' : '',
      fabric ? fabric[`yarn2_${attr}`] || '' : '',
      fabric ? fabric[`yarn3_${attr}`] || '' : '',
      fabric ? fabric[`yarn4_${attr}`] || '' : '',
    ]);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(1).fill = LABEL_FILL;
    row.eachCell(c => { c.border = BORDER_ALL; c.alignment = { vertical: 'middle' }; });
  });
  sheet.addRow([]);

  sectionHeader(sheet, 'STYLE DETAIL');
  labelRow(sheet, 'Department / Season', [style ? style.department : '', order ? order.season : ''].filter(Boolean).join(' / '));
  labelRow(sheet, 'Style number', order ? order.style_no : (style ? style.style_no : ''));
  labelRow(sheet, 'Style description', order ? order.description : (style ? style.description : ''));
  sheet.addRow([]);

  sectionHeader(sheet, 'SUPPLIER DETAIL');
  const supplierHeadRow = sheet.addRow(['', '', 'Country of origin']);
  supplierHeadRow.eachCell(c => { c.font = { bold: true }; });
  labelRow(sheet, 'Garment Manufacturer', factory ? (factory.registered_name || factory.name) : '')
    .getCell(3).value = factory ? factory.country : '';
  labelRow(sheet, 'Fabric supplier', fabric ? fabric.fabric_supplier : '')
    .getCell(3).value = fabric ? fabric.country_of_origin : '';
  labelRow(sheet, 'Yarn supplier', fabric ? fabric.yarn_supplier : '')
    .getCell(3).value = fabric ? fabric.country_of_origin : '';
  labelRow(sheet, 'Date and Supplier sign off', '');

  return workbook;
}

module.exports = { buildMaterialSubmissionWorkbook };
