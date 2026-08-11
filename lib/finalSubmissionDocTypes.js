// The fixed set of documents PnP's own "BULK SUBMISSION CHECKLIST" workbook
// requires per order (see public/final-submission/PnP BULK SUBMISSION
// CHECKLIST - LADIES.xlsx) - shared between routes/finalSubmission.js (what
// slots exist, how each gets filled) and lib/submissionChecklistExport.js
// (rendering the checklist itself). Order fixed to match the buyer's sheet.
//
// source: 'upload' - only ever comes from a file the merchandiser attaches
//         (PO, inspection/audit reports, tech pack, third-party cert) -
//         nothing in the CRM can generate these.
//  'linked' - satisfied automatically once a fabric_test_reports row is
//         linked to the style (see fabric_report_styles) for the order's
//         fabric_code, same as the rest of the app's fabric test tracking -
//         still upload-able manually as a fallback/override.
//  'generate' - built on demand from data already in the CRM.
//
// washcare_label isn't one of PnP's own 8 checklist items - it's a 9th,
// Elanzas-added slot (see the Wash Care tab's generateStyleWashcareLabel)
// since a compliant wash care label is still something every style needs
// even though this particular buyer checklist doesn't itemise it.
const DOC_TYPES = [
  { key: 'sap_po', label: 'Latest SAP PO', source: 'upload' },
  { key: 'bulk_audit_report', label: 'Bulk Audit Report', source: 'upload' },
  { key: 'graded_spec', label: 'Graded Spec', source: 'upload' },
  { key: 'aql_report', label: 'AQL Report', source: 'upload' },
  { key: 'fabric_test_report', label: 'Fabric Test Report', source: 'linked' },
  { key: 'sample_appraisal_report', label: 'Sample Appraisal Report', source: 'generate' },
  { key: 'third_party_report', label: '3rd Party Report', source: 'upload', optional: true },
  { key: 'data_sheet', label: 'Data Sheet (Material Submission form)', source: 'generate' },
  { key: 'washcare_label', label: 'Wash Care Label', source: 'generate' },
];

module.exports = { DOC_TYPES };
