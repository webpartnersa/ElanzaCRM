// ---- Fabrics: base fabric codes, each carrying just a composition and
// weight - nothing report-specific lives here, that's all on
// fabric_test_reports (see the Upload Test Report flow below, which also
// cascades the latest report's composition/weight onto the fabric here).
// Feeds the fabric autofill in the order drawer (shipping.js). The
// renewal-reminder check in the Notification Centre (notifications.js)
// reads per-report dates from fabric_test_reports, not from here.

function initFabricsState(){
  if (!state.fabrics) state.fabrics = [];
  if (state.fabricDrawer === undefined) state.fabricDrawer = null;
  if (state.testReportUpload === undefined) state.testReportUpload = null;
  if (state.fabricsSubview === undefined) state.fabricsSubview = null;
  if (state.fabricReports === undefined) state.fabricReports = null;
  if (state.fabricReportsSearch === undefined) state.fabricReportsSearch = '';
  if (state.fabricReportFlags === undefined) state.fabricReportFlags = [];
}

async function loadFabrics(){
  initFabricsState();
  const { fabrics } = await api('/api/fabrics');
  state.fabrics = fabrics;
  render();
}

// Composition/weight mismatches flagged when a report was uploaded for a
// fabric code that already had different values on file - feeds the
// Notification Centre's "Fabric data inconsistencies" section.
async function loadFabricReportFlags(){
  initFabricsState();
  const { flags } = await api('/api/fabrics/report-flags');
  state.fabricReportFlags = flags;
  render();
}

// ---- Fabrics section: Reports (every test report ever uploaded, across
// every fabric) is the default landing view - the Fabrics codes list is a
// secondary view reached via the "Fabrics" link at the top of Reports. ----
function gotoFabrics(){
  initFabricsState();
  state.view = 'fabrics';
  state.fabricsSubview = null;
  state.modal = null;
  render();
  loadFabrics();
  loadAllFabricReports();
}
function showFabricCodesList(){
  state.fabricsSubview = 'codes';
  render();
}
function showFabricReportsList(){
  state.fabricsSubview = null;
  render();
  if (!state.fabricReports) loadAllFabricReports();
}
async function loadAllFabricReports(){
  try {
    const { reports } = await api('/api/fabrics/reports');
    state.fabricReports = reports;
    render();
  } catch (e) { toast(e.message); }
}

// Test reports print weight as grams/m² (GSM); fabrics.weight is stored in
// ounces (the unit used everywhere else in the app) - divide by 33.9 to
// convert, per the standard GSM -> oz/yd² factor.
function gsmToOz(gsm){
  const n = parseFloat(gsm);
  if (!gsm || isNaN(n)) return '';
  return (n / 33.9).toFixed(2);
}

// Field list for the test-report upload/review/edit form (fabric_test_reports
// only - the fabrics table itself only carries code/composition/weight now,
// see renderFabricDrawerHost). reportKey exists because a couple of report
// fields (weight_oz, report_date) are read under different names elsewhere;
// everything else here (labels, ids, order) just uses the key as-is.
const REPORT_FIELD_DEFS = {
  composition:           { label: 'Composition', type: 'text', placeholder: 'e.g. 95.3% COTTON / 3.3% VISCOSE / 1.4% ELASTANE', reportKey: 'composition' },
  weight_gsm:            { label: 'Weight (g/m² - as printed on report)', type: 'text', reportKey: 'weight_gsm' },
  weight_oz:             { label: 'Weight (oz - saved to fabric)', type: 'text', placeholder: 'e.g. 11.12', reportKey: 'weight_oz' },
  report_number:         { label: 'Report number', type: 'text', placeholder: 'e.g. NQA260113071', reportKey: 'report_number' },
  report_date:           { label: 'Report / approval date', type: 'date', reportKey: 'report_date' },
  style_no:              { label: 'Style no.', type: 'text', reportKey: 'style_no' },
  end_buyer:             { label: 'End buyer', type: 'text', reportKey: 'end_buyer' },
  sample_description:    { label: 'Sample description', type: 'textarea', reportKey: 'sample_description' },
  overall_result:        { label: 'Overall result', type: 'text', reportKey: 'overall_result' },
};
const REPORT_FIELD_ROWS = [
  ['composition'], ['weight_gsm', 'weight_oz'], ['report_number', 'report_date'],
  ['style_no', 'end_buyer'], ['sample_description'], ['overall_result'],
];

// Approval date + 12 months, as an ISO date string - the default lab
// approval window, used as the legacy fallback in fabricExpiry() below.
function addOneYearISO(dateStr){
  const d = parseShipDate(dateStr);
  if (!d) return '';
  return toLocalISODate(new Date(d.getFullYear(), d.getMonth() + 12, d.getDate()));
}

function renderReportField(key, prefix, value){
  const def = REPORT_FIELD_DEFS[key];
  const id = `${prefix}-${key}`;
  const v = value || '';
  let onchange = '';
  if (key === 'weight_gsm') onchange = ` onchange="document.getElementById('${prefix}-weight_oz').value = gsmToOz(this.value)"`;
  if (def.type === 'textarea') return `<div class="field"><label>${def.label}</label><textarea id="${id}"${onchange}>${v}</textarea></div>`;
  if (def.type === 'date') return `<div class="field"><label>${def.label}</label><input id="${id}" type="date" value="${v}"${onchange}/></div>`;
  return `<div class="field"><label>${def.label}</label><input id="${id}" value="${v}" placeholder="${def.placeholder||''}"${onchange}/></div>`;
}
function renderReportFieldRows(prefix, values){
  return REPORT_FIELD_ROWS.map(row => row.length === 1
    ? renderReportField(row[0], prefix, values[row[0]])
    : `<div class="row2">${row.map(k=>renderReportField(k, prefix, values[k])).join('')}</div>`
  ).join('');
}

// Prefers the stored valid_until (editable in the fabric drawer, defaults
// to approval_date + 12 months but can be overridden if a lab specifies a
// different validity period) - falls back to a computed 12-month window for
// fabrics saved before that field existed.
function fabricExpiry(fabric){
  const iso = fabric.valid_until || addOneYearISO(fabric.approval_date);
  return iso ? parseShipDate(iso) : null;
}
// 30 days before expiry = "renewal required" - the reminder window asked for.
function fabricStatus(fabric){
  const expiry = fabricExpiry(fabric);
  if (!expiry) return { label: 'No approval date', cls: 'fabric-status-none' };
  const daysLeft = Math.round((expiry - new Date()) / (1000*60*60*24));
  if (daysLeft < 0) return { label: `Expired ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-expired' };
  if (daysLeft <= 30) return { label: `Renew by ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-warn' };
  return { label: `Valid until ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-ok' };
}

function renderFabricsView(){
  initFabricsState();
  if (state.fabricsSubview === 'codes') return renderFabricCodesList();
  return renderFabricReportsList();
}

function renderFabricCodesList(){
  const canEdit = state.user.role !== 'buyer';
  const rows = state.fabrics.slice().sort((a,b)=>a.code.localeCompare(b.code)).map(f => `
      <tr>
        <td class="name-cell mono">${f.code}</td>
        <td>${f.composition||''}</td>
        <td>${f.weight ? f.weight + ' oz' : ''}</td>
        <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="openEditFabric(${f.id})">Edit</button></td>
      </tr>`
  ).join('') || `<tr><td colspan="4"><div class="empty-state">No fabrics added yet.</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Fabrics</h1><p>${state.fabrics.length} fabric${state.fabrics.length===1?'':'s'}</p></div>
      <div class="row-actions">
        <button class="btn btn-ghost" onclick="showFabricReportsList()">← Back to Reports</button>
        ${canEdit ? `<button class="btn btn-primary" onclick="openNewFabric()">+ New Fabric</button>` : ''}
      </div>
    </div>
    <div class="hint" style="margin-top:8px;">Base fabric codes - just composition and weight. Lab report validity and renewal status are tracked per report - see Fabric Reports and Notifications.</div>
    <div class="contacts-wrap" style="margin-top:14px;">
      <table class="contacts-table">
        <thead>
          <tr><th>Fabric code</th><th>Composition</th><th>Weight</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderFabricDrawerHost()}
  `;
}

// Matches the search box against every field a user would plausibly search
// a report by - report number, fabric code, style no. and overall result.
function matchesFabricReportSearch(r, term){
  if (!term) return true;
  const haystack = [r.report_number, r.fabric_code, r.style_no, r.overall_result].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(term.toLowerCase());
}
function onFabricReportsSearch(value){
  state.fabricReportsSearch = value;
  render();
  const el = document.getElementById('fabric-reports-search');
  if (el) {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
}

function renderFabricReportsList(){
  const reports = state.fabricReports;
  const canEdit = state.user.role !== 'buyer';
  const search = state.fabricReportsSearch || '';
  const filtered = (reports || []).filter(r => matchesFabricReportSearch(r, search));
  const rows = filtered.map(r => {
    // Same 12-month-from-report-date validity window as the Fabrics list's
    // own Status column (fabricStatus/fabricExpiry) - just fed this
    // report's own date instead of the fabric's latest approval_date, so
    // an older report shows as expired even if a newer one for the same
    // fabric is still valid.
    const status = fabricStatus({ approval_date: r.report_date });
    return `
    <tr>
      <td class="name-cell mono"><a href="${r.file_path}" target="_blank" rel="noopener">${r.report_number || 'Report'}</a></td>
      <td class="mono">${r.fabric_code}</td>
      <td>${r.style_no||''}</td>
      <td>${r.report_date ? formatShipDateShort(r.report_date) : ''}</td>
      <td>${r.report_type==='print' ? 'Print/Embellishment' : 'Base'}</td>
      <td>${r.weight_oz ? r.weight_oz+' oz' : (r.weight_gsm ? r.weight_gsm+' g/m²' : '')}</td>
      <td>${r.overall_result||''}</td>
      <td><span class="fabric-status ${status.cls}">${status.label}</span></td>
      <td style="text-align:right;">${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openEditTestReport(${r.id})">Edit</button>` : ''}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="9"><div class="empty-state">${reports === null ? 'Loading...' : (search ? 'No reports match your search.' : 'No test reports uploaded yet.')}</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Fabric Reports</h1><p>${reports ? filtered.length : 0}${reports && filtered.length!==reports.length ? ` of ${reports.length}` : ''} report${(reports ? filtered.length : 0)===1?'':'s'}</p></div>
      <div class="row-actions">
        <button class="btn btn-ghost" onclick="showFabricCodesList()">Fabrics</button>
        ${canEdit ? `<button class="btn btn-primary" onclick="openTestReportUpload()">+ Upload Test Report</button>` : ''}
      </div>
    </div>
    <div class="field" style="margin-top:12px;max-width:360px;">
      <input id="fabric-reports-search" type="search" placeholder="Search by report #, fabric code, style no. or result..." value="${search.replace(/"/g,'&quot;')}" oninput="onFabricReportsSearch(this.value)"/>
    </div>
    <div class="hint" style="margin-top:8px;">Every lab test report uploaded, across every fabric - click a report number to view the PDF. Status is valid for 12 months from that report's own date, same as the Fabrics list.</div>
    <div class="contacts-wrap" style="margin-top:14px;">
      <table class="contacts-table">
        <thead>
          <tr><th>Report #</th><th>Fabric code</th><th>Style no.</th><th>Report date</th><th>Type</th><th>Weight</th><th>Overall result</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderFabricDrawerHost()}
  `;
}

// Same field set as FABRIC_FIELDS in routes/fabrics.js - see db.js's
// comment on these columns for why they exist (Pick n Pay's Material
// Submission form).
const FABRIC_DETAIL_FIELDS = ['description', 'fabric_type', 'construction', 'construction_gauge', 'finishes'];
const FABRIC_SUPPLIER_FIELDS = ['fabric_supplier', 'yarn_supplier', 'country_of_origin'];
const YARN_ATTRS = [['type','Type'], ['composition','Composition'], ['spinning','Spinning'], ['count','Count'], ['sustainability','Sustainability']];

function blankFabricDraft(){
  const draft = { id:null, code:'', composition:'', weight:'' };
  FABRIC_DETAIL_FIELDS.forEach(f => { draft[f] = ''; });
  FABRIC_SUPPLIER_FIELDS.forEach(f => { draft[f] = ''; });
  [1,2,3,4].forEach(n => YARN_ATTRS.forEach(([attr]) => { draft[`yarn${n}_${attr}`] = ''; }));
  return draft;
}

// The Yarn Detail table - rows are attributes (Type/Composition/...), columns
// are Yarn 1-4, same layout as the PDF form's own grid.
function renderYarnDetailTable(f){
  const rows = YARN_ATTRS.map(([attr, label]) => `
    <tr>
      <td style="font-weight:600;white-space:nowrap;">${label}</td>
      ${[1,2,3,4].map(n => `<td><input id="fb-yarn${n}_${attr}" value="${(f[`yarn${n}_${attr}`]||'').toString().replace(/"/g,'&quot;')}"/></td>`).join('')}
    </tr>`).join('');
  return `
    <table class="contacts-table" style="margin-top:8px;">
      <thead><tr><th></th><th>Yarn 1</th><th>Yarn 2</th><th>Yarn 3</th><th>Yarn 4</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function openNewFabric(){
  state.fabricDrawer = { fabric: blankFabricDraft(), isNew:true };
  render();
}
function openEditFabric(id){
  const f = state.fabrics.find(x=>x.id===id);
  if (!f) return;
  state.fabricDrawer = { fabric: {...f}, isNew:false };
  render();
}
function closeFabricDrawer(){ state.fabricDrawer = null; render(); }

function renderFabricDrawerHost(){
  const d = state.fabricDrawer;
  if (!d) return `<div class="overlay" onclick="closeFabricDrawer()"></div><div class="drawer"></div>`;
  const f = d.fabric;
  return `
    <div class="overlay open" onclick="closeFabricDrawer()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${d.isNew ? 'New Fabric' : f.code}</h2>
        <button class="drawer-close" onclick="closeFabricDrawer()">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="field"><label>Fabric code</label><input id="fb-code" value="${f.code||''}" placeholder="e.g. 3895"/></div>
        <div class="field"><label>Composition</label><input id="fb-composition" value="${f.composition||''}" placeholder="e.g. 95.3% COTTON / 3.3% VISCOSE / 1.4% ELASTANE"/></div>
        <div class="field"><label>Weight (oz)</label><input id="fb-weight" value="${f.weight||''}" placeholder="e.g. 11.12"/></div>

        <div class="field" style="margin-top:18px;"><label>Fabric details</label></div>
        <div class="field"><label>Description</label><input id="fb-description" value="${f.description||''}" placeholder="e.g. 401 twill"/></div>
        <div class="row2">
          <div class="field"><label>Fabric type</label>
            <select id="fb-fabric_type">
              <option value="" ${!f.fabric_type?'selected':''}>-</option>
              <option value="Knit" ${f.fabric_type==='Knit'?'selected':''}>Knit</option>
              <option value="Woven" ${f.fabric_type==='Woven'?'selected':''}>Woven</option>
            </select>
          </div>
          <div class="field"><label>Construction</label><input id="fb-construction" value="${f.construction||''}" placeholder="e.g. Twill, Poplin, 1x1 Rib"/></div>
        </div>
        <div class="field"><label>Construction gauge</label><input id="fb-construction_gauge" value="${f.construction_gauge||''}" placeholder="Warp x weft, or courses x wales per inch - e.g. 12x21"/></div>
        <div class="field"><label>Finishes and processing</label><input id="fb-finishes" value="${f.finishes||''}" placeholder="e.g. brushing/sueding/printing"/></div>

        <div class="field" style="margin-top:18px;"><label>Supplier detail</label></div>
        <div class="row2">
          <div class="field"><label>Fabric supplier</label><input id="fb-fabric_supplier" value="${f.fabric_supplier||''}"/></div>
          <div class="field"><label>Yarn supplier</label><input id="fb-yarn_supplier" value="${f.yarn_supplier||''}"/></div>
        </div>
        <div class="field"><label>Country of origin</label><input id="fb-country_of_origin" value="${f.country_of_origin||''}"/></div>

        <div class="field" style="margin-top:18px;"><label>Yarn detail</label></div>
        ${renderYarnDetailTable(f)}
      </div>
      <footer class="drawer-actions">
        ${!d.isNew ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteFabric(${f.id})">Delete</button>` : ''}
        <button class="btn btn-primary" onclick="saveFabric()">${d.isNew ? 'Save fabric' : 'Save changes'}</button>
      </footer>
    </div>`;
}

async function saveFabric(){
  const code = document.getElementById('fb-code').value.trim();
  if (!code) { toast('Fabric code is required'); return; }
  const body = {
    code,
    composition: document.getElementById('fb-composition').value.trim(),
    weight: document.getElementById('fb-weight').value.trim(),
  };
  FABRIC_DETAIL_FIELDS.forEach(f => { body[f] = document.getElementById('fb-'+f).value.trim(); });
  FABRIC_SUPPLIER_FIELDS.forEach(f => { body[f] = document.getElementById('fb-'+f).value.trim(); });
  [1,2,3,4].forEach(n => YARN_ATTRS.forEach(([attr]) => {
    const id = `yarn${n}_${attr}`;
    body[id] = document.getElementById('fb-'+id).value.trim();
  }));
  try {
    const { isNew, fabric } = state.fabricDrawer;
    if (isNew) {
      await api('/api/fabrics', { method:'POST', body: JSON.stringify(body) });
      toast('Fabric added');
    } else {
      await api('/api/fabrics/'+fabric.id, { method:'PUT', body: JSON.stringify(body) });
      toast('Fabric updated');
    }
    closeFabricDrawer();
    await loadFabrics();
  } catch(e) { toast(e.message); }
}

async function deleteFabric(id){
  if (!confirm('Remove this fabric? This also deletes its uploaded test reports.')) return;
  try {
    await api('/api/fabrics/'+id, { method:'DELETE' });
    state.fabrics = state.fabrics.filter(f=>f.id!==id);
    closeFabricDrawer();
    toast('Fabric removed');
  } catch(e) { toast(e.message); }
}

// ---- Upload Test Report: two-step flow - upload+extract, then review the
// AI-read fields (editable) before anything is saved to the database. ----

function openTestReportUpload(){
  state.testReportUpload = { stage:'pick', busy:false, error:'', filePath:null, fields:null, fabricCode: '', reportType: 'base' };
  render();
}
function closeTestReportUpload(){ state.testReportUpload = null; render(); }

function renderTestReportUploadHost(){
  const t = state.testReportUpload;
  if (!t) return `<div class="overlay" onclick="closeTestReportUpload()"></div><div class="drawer"></div>`;

  const codeOptions = state.fabrics.map(f=>`<option value="${f.code}">`).join('');

  let body;
  if (t.stage === 'pick') {
    body = `
      <div class="field">
        <label>Lab test report (PDF)</label>
        <input type="file" id="tr-file" accept="application/pdf"/>
        <div class="hint" style="margin-top:6px;">Composition, weight, report number and dates are read automatically - you'll get a chance to check and correct everything before it's saved.</div>
      </div>
      ${t.error ? `<div class="error-msg" style="color:var(--stitch-red);font-size:12.5px;margin-top:8px;">${t.error}</div>` : ''}
    `;
  } else if (t.stage === 'review') {
    const x = t.fields;
    const values = {};
    Object.keys(REPORT_FIELD_DEFS).forEach(key => { values[key] = x[REPORT_FIELD_DEFS[key].reportKey]; });
    if (values.weight_oz == null) values.weight_oz = gsmToOz(values.weight_gsm);
    body = `
      <div class="field">
        <label>Report Type</label>
        <select id="tr-report_type" onchange="state.testReportUpload.reportType = this.value">
          <option value="base" ${t.reportType!=='print'?'selected':''}>Base / Bulk Fabric Report</option>
          <option value="print" ${t.reportType==='print'?'selected':''}>Print / Embellishment Report</option>
        </select>
        <div class="hint" style="margin-top:4px;">A Print/Embellishment report is required in addition to the base report whenever a concept has Print or Embroidery/Applique details.</div>
      </div>
      <div class="field">
        <label>Fabric code</label>
        <input id="tr-fabric_code" list="tr-fabric-codes" value="${t.fabricCode||''}" placeholder="Pick an existing code or type a new one"/>
        <datalist id="tr-fabric-codes">${codeOptions}</datalist>
        <div class="hint" style="margin-top:4px;">Auto-filled when spotted in the sample description - double check it, or pick/type a different code.</div>
      </div>
      ${renderReportFieldRows('tr', values)}
      ${t.error ? `<div class="error-msg" style="color:var(--stitch-red);font-size:12.5px;margin-top:8px;">${t.error}</div>` : ''}
    `;
  }

  return `
    <div class="overlay open" onclick="closeTestReportUpload()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${t.isEdit ? 'Edit Test Report' : 'Upload Test Report'}</h2>
        <button class="drawer-close" onclick="closeTestReportUpload()">&times;</button>
      </div>
      <div class="drawer-body">${body}</div>
      <footer class="drawer-actions">
        ${t.isEdit ? `<button class="btn btn-danger" style="margin-right:auto;" ${t.busy?'disabled':''} onclick="deleteTestReport()">Delete</button>` : ''}
        ${t.stage === 'pick'
          ? `<button class="btn btn-primary" ${t.busy?'disabled':''} onclick="extractTestReport()">${t.busy ? 'Reading PDF...' : 'Extract Data'}</button>`
          : `<button class="btn btn-primary" ${t.busy?'disabled':''} onclick="saveTestReport()">${t.busy ? 'Saving...' : (t.isEdit ? 'Save changes' : 'Save')}</button>`}
      </footer>
    </div>`;
}

// Edits an already-saved report - opens the exact same review-stage form
// used right after a fresh extraction, just pre-filled from the saved row
// instead of freshly-read PDF text, and skipping the "pick a PDF" stage
// entirely since there's nothing to (re-)upload. saveTestReport() below
// checks isEdit to PUT instead of POST. Looks the report up from whichever
// list is currently showing it.
function openEditTestReport(reportId){
  const sources = [
    (state.drawer && state.drawer.fabricReports) || [],
    state.fabricReports || [],
  ];
  const report = sources.flat().find(r => r.id === reportId);
  if (!report) { toast('Could not find that report'); return; }
  state.testReportUpload = {
    stage: 'review', busy: false, error: '',
    filePath: report.file_path,
    fields: {
      report_number: report.report_number, style_no: report.style_no, end_buyer: report.end_buyer,
      sample_description: report.sample_description, report_date: report.report_date,
      weight_gsm: report.weight_gsm, weight_oz: report.weight_oz, composition: report.composition,
      overall_result: report.overall_result,
    },
    fabricCode: report.fabric_code,
    reportType: report.report_type || 'base',
    isEdit: true,
    editId: report.id,
  };
  render();
}

async function extractTestReport(){
  const fileInput = document.getElementById('tr-file');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { toast('Choose a PDF first'); return; }

  state.testReportUpload.busy = true;
  state.testReportUpload.error = '';
  render();

  try {
    const formData = new FormData();
    formData.append('report', file);
    const res = await fetch('/api/fabrics/test-reports/extract', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Could not read that PDF');

    state.testReportUpload.stage = 'review';
    state.testReportUpload.filePath = data.filePath;
    state.testReportUpload.fields = data.extracted;
    // Only auto-fill from the extraction if a fabric wasn't already chosen
    // up front (e.g. uploading from inside that fabric's own drawer) - an
    // explicit prior choice always wins over a guess pulled from free text.
    if (!state.testReportUpload.fabricCode && data.extracted.fabric_code) {
      state.testReportUpload.fabricCode = data.extracted.fabric_code;
    }
    // Smart-default Report Type from the sample description text - NQA's
    // print-durability reports describe the sample as "printed fabric"
    // rather than "solid fabric".
    const desc = (data.extracted.sample_description || '').toLowerCase();
    state.testReportUpload.reportType = desc.includes('printed') ? 'print' : 'base';
    state.testReportUpload.busy = false;
    render();
  } catch (e) {
    state.testReportUpload.busy = false;
    state.testReportUpload.error = e.message;
    render();
  }
}

async function saveTestReport(){
  const t = state.testReportUpload;
  const fabric_code = document.getElementById('tr-fabric_code').value.trim();
  if (!fabric_code) { toast('Fabric code is required'); return; }

  const body = { fabric_code, report_type: t.reportType || 'base' };
  if (!t.isEdit) body.file_path = t.filePath;
  Object.keys(REPORT_FIELD_DEFS).forEach(key => {
    const el = document.getElementById('tr-'+key);
    if (el) body[REPORT_FIELD_DEFS[key].reportKey] = el.value.trim();
  });

  t.busy = true;
  render();
  try {
    if (t.isEdit) {
      await api('/api/fabrics/test-reports/'+t.editId, { method:'PUT', body: JSON.stringify(body) });
      toast('Report updated');
    } else {
      const saved = await api('/api/fabrics/test-reports', { method:'POST', body: JSON.stringify(body) });
      toast(saved.inconsistencyMessage
        ? `Saved, but flagged: ${saved.inconsistencyMessage}`
        : `Test report saved to ${fabric_code}`);
      await loadFabricReportFlags();
    }
    closeTestReportUpload();
    await loadFabrics();
    await loadAllFabricReports();
    if (state.fabricDrawer && state.fabricDrawer.fabric.code === fabric_code) {
      openEditFabric(state.fabricDrawer.fabric.id);
    }
    // A new report can auto-link to whichever style(s) its Style No. text
    // matches - refresh the Style drawer's Fabric Report tab if one's open.
    if (state.drawer && state.drawer.style && !state.drawer.isNew) {
      openStyle(state.drawer.style.id);
    }
  } catch (e) {
    t.busy = false;
    t.error = e.message;
    render();
  }
}

async function deleteTestReport(){
  const t = state.testReportUpload;
  if (!confirm('Delete this test report? This removes the PDF and unlinks it from any style - it can\'t be undone.')) return;
  const fabricCode = t.fabricCode;
  t.busy = true;
  render();
  try {
    await api('/api/fabrics/test-reports/'+t.editId, { method:'DELETE' });
    toast('Report deleted');
    closeTestReportUpload();
    await loadFabrics();
    await loadAllFabricReports();
    if (state.fabricDrawer && state.fabricDrawer.fabric.code === fabricCode) {
      openEditFabric(state.fabricDrawer.fabric.id);
    }
    if (state.drawer && state.drawer.style && !state.drawer.isNew) {
      openStyle(state.drawer.style.id);
    }
  } catch (e) {
    t.busy = false;
    t.error = e.message;
    render();
  }
}
