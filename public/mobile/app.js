const DEPARTMENTS = ['Ladies','Mens','Younger Boys','Older Boys','Younger Girls','Older Girls','Babywear'];
const RETAILERS = ['PnP','Eagle','PEP'];

// Every editable concept field, defaulted blank - mirrors public/js/concepts.js's
// blankConceptDraft() so mobile create/edit carries the exact same field set as
// the desktop portal's Concept drawer, field for field.
function blankFormConcept(){
  return {
    department: DEPARTMENTS[0], description:'', source:'', tags:'',
    concept_date: new Date().toISOString().slice(0,7), size_range_id:'',
    fabric_code:'', composition:'', weight:'',
    wash:'', colour:'', print:'', embroidery_applique:'', topstitching:'', trims:'', styling:'',
    units:'', packing:'', labels:'',
    factory:'', shipping_date:'', dc_date:'',
    cost_estimate:'', buyer_rand_target:'', buyer_rsp_target:'', factory_target_price:'', factory_price:'', factory_cost_options:'',
  };
}
function blankFormState(isNew){
  return {
    isNew, id:null, concept_no:'', concept: blankFormConcept(), specCategoryId:null,
    photos:[], pendingFiles:[], tab:'details', submitting:false, error:'', validationHint:'',
    cadBusy:false, cadPreview:null, conversions:[],
  };
}

const state = {
  screen: 'loading', // loading | login | home | form | browse | detail | success | specAdmin | sizeAdmin
  user: null,
  loginBusy: false,
  loginError: '',

  // lookup data, shared by the create/edit form and the read-only detail view
  fabrics: [],
  specCategories: [],
  sizeRanges: [],

  // unified create/edit concept form - see blankFormState()
  form: null,
  lastCreated: null, // { concept_no, department } - success screen after a create

  // browse
  concepts: [],
  conceptsLoading: false,
  conceptsError: '',
  browseFilter: '',

  // detail (read-only view before editing)
  conceptDetail: null, // { concept, photos, conversions }
  conceptDetailLoading: false,
  conceptDetailError: '',

  lightboxUrl: null,

  // spec hierarchy admin screen
  specAdmin: null, // { department }

  // install prompt
  installPromptEvent: null, // captured 'beforeinstallprompt' event, Android/Chrome only
  installBannerDismissed: false,
  isIOS: /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase()),
  isStandalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
};

const ICONS = {
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M20 15l-5-5-9 9"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>'
};

function esc(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function hasConceptsPermission(){
  return (state.user.permissions || '').split(',').filter(Boolean).includes('concepts');
}

// Renders a labeled row in the concept detail view; skipped entirely when
// empty so buyer-scoped fields (cost_estimate/factory, stripped server-side)
// don't leave blank rows.
function detailField(label, value){
  if (!value) return '';
  return `<div class="detail-field-row"><span class="detail-field-label">${esc(label)}</span><span class="detail-field-value">${esc(value)}</span></div>`;
}

function formatMonth(yyyymm){
  if (!yyyymm) return '';
  const [y, m] = yyyymm.split('-');
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const idx = parseInt(m, 10) - 1;
  return (names[idx] || m) + ' ' + y;
}

function photoBadge(p){
  if (p.role === 'cad') return `<span class="photo-role-badge">CAD</span>`;
  if (p.role === 'cad_detail' && p.label) return `<span class="photo-role-badge">${esc(p.label)}</span>`;
  if (p.role === 'detail') return `<span class="photo-role-badge">Detail</span>`;
  return '';
}

// Walks the spec category tree up from a leaf id to build a readable
// "Denim > Skinny" path for the read-only detail view.
function specPathLabel(specCategoryId){
  if (!specCategoryId) return '';
  const byId = {};
  (state.specCategories||[]).forEach(n => { byId[n.id] = n; });
  let cur = byId[specCategoryId];
  if (!cur) return '';
  const parts = [cur.name];
  while (cur.parent_id) { cur = byId[cur.parent_id]; if (!cur) break; parts.unshift(cur.name); }
  return parts.join(' > ');
}
function sizeRangeLabel(sizeRangeId){
  if (!sizeRangeId) return '';
  const r = (state.sizeRanges||[]).find(r => String(r.id) === String(sizeRangeId));
  return r ? r.values.join(' / ') : '';
}

// ---- Toast (mobile has no other transient-feedback mechanism) ----
let _toastTimer = null;
function showToast(msg){
  let el = document.getElementById('mobile-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mobile-toast';
    el.className = 'mobile-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---- Screens ----

function renderLoading(){
  return `<div class="auth-screen"><div class="spinner"></div></div>`;
}

function renderLogin(){
  return `
  <div class="auth-screen">
    <div class="auth-card">
      <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
      <h1>Elanzas</h1>
      <p class="sub">Quick Concept Capture</p>
      ${state.loginError ? `<div class="error-msg">${esc(state.loginError)}</div>` : ''}
      <form id="loginForm">
        <div class="field">
          <label>Email</label>
          <input type="email" id="loginEmail" autocomplete="username" required/>
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="loginPassword" autocomplete="current-password" required/>
        </div>
        <button type="submit" class="btn-block primary" ${state.loginBusy ? 'disabled' : ''}>${state.loginBusy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  </div>`;
}

function renderHome(){
  if (!hasConceptsPermission()) {
    return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
        <h1>Not available</h1>
        <p class="sub">Your account doesn't have access to Concepts. Signed in as ${esc(state.user.name)}.</p>
        <button class="btn-block ghost" onclick="logout()">Sign out</button>
      </div>
    </div>`;
  }
  const canCreate = state.user.role !== 'buyer';
  return `
  <div class="topbar">
    <div class="who">
      <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
      <div>
        <h1>Elanzas</h1>
        <p class="user-name">${esc(state.user.name)}</p>
      </div>
    </div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>
  <div class="home-scroll">
    ${canCreate ? `
    <button class="dash-tile" onclick="openCreateConcept()">
      <div class="dash-icon">${ICONS.camera}</div>
      <div class="dash-text">
        <span class="dash-title">New Concept</span>
        <span class="dash-sub">Capture with photos</span>
      </div>
      <span class="dash-chevron">${ICONS.chevronRight}</span>
    </button>` : ''}
    <button class="dash-tile" onclick="goToBrowse()">
      <div class="dash-icon">${ICONS.grid}</div>
      <div class="dash-text">
        <span class="dash-title">Browse Concepts</span>
        <span class="dash-sub">View, edit and manage existing concepts</span>
      </div>
      <span class="dash-chevron">${ICONS.chevronRight}</span>
    </button>
  </div>`;
}

// ---- Unified create/edit concept form ----

function renderFormScreen(){
  const f = state.form;
  if (!f) {
    return `
    <div class="topbar">
      <button class="back-btn" onclick="history.back()">${ICONS.back}</button>
      <div class="topbar-title"><h1>Concept</h1></div>
      <button class="signout" onclick="logout()">Sign out</button>
    </div>
    <div class="form-scroll"><div class="spinner" style="margin-top:40px;"></div></div>`;
  }
  if (f.loadError) {
    return `
    <div class="topbar">
      <button class="back-btn" onclick="history.back()">${ICONS.back}</button>
      <div class="topbar-title"><h1>Concept</h1></div>
      <button class="signout" onclick="logout()">Sign out</button>
    </div>
    <div class="form-scroll"><div class="error-msg" style="margin-top:20px;">${esc(f.loadError)}</div></div>`;
  }

  const showTabs = !f.isNew;
  const tab = f.tab || 'details';
  return `
  <div class="topbar">
    <button class="back-btn" onclick="closeForm()">${ICONS.back}</button>
    <div class="topbar-title"><h1>${f.isNew ? 'New Concept' : esc(f.concept_no)}</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>
  ${showTabs ? `
    <div class="form-tabs">
      <button class="form-tab-btn ${tab==='details'?'active':''}" onclick="setFormTab('details')">Details</button>
      <button class="form-tab-btn ${tab==='costs'?'active':''}" onclick="setFormTab('costs')">Costs</button>
      <button class="form-tab-btn ${tab==='cad'?'active':''}" onclick="setFormTab('cad')">CAD</button>
    </div>
  ` : ''}
  <div class="form-scroll">
    ${(!showTabs || tab==='details') ? renderFormPhotosSection() + renderFormDetailsSection() : ''}
    ${(!showTabs || tab==='costs') ? renderFormCostsSection() : ''}
    ${showTabs && tab==='cad' ? renderFormCadSection() : ''}
    ${!f.isNew && f.conversions && f.conversions.length ? `
      <div class="section">
        <div class="section-label">Converted To</div>
        <div class="chip-grid">${f.conversions.map(cv=>`<span class="chip selected" style="pointer-events:none;">${esc(cv.style_no)}</span>`).join('')}</div>
      </div>` : ''}
    ${!f.isNew ? `
      <div class="section">
        <div class="section-hint">Converting to a Style isn't available on mobile yet - open this concept on the desktop portal to convert it.</div>
      </div>
      ${f.photos.some(p=>p.role!=='cad'&&p.role!=='cad_detail') ? `<button class="btn-block ghost" onclick="shareConceptWhatsApp()">Share via WhatsApp</button>` : ''}
      <button class="btn-block ghost" style="border-color:var(--stitch-red);color:var(--stitch-red);" onclick="deleteFormConcept()">Delete Concept</button>
    ` : ''}
    ${f.error ? `<div class="error-msg" style="margin-top:14px;">${esc(f.error)}</div>` : ''}
  </div>
  <div class="bottom-bar">
    ${f.validationHint ? `<div class="validation-hint">${esc(f.validationHint)}</div>` : ''}
    <button class="btn-block primary" ${f.submitting ? 'disabled' : ''} onclick="submitForm()">${f.submitting ? 'Saving...' : (f.isNew ? 'Create Concept' : 'Save Changes')}</button>
  </div>`;
}

function renderFormPhotosSection(){
  const f = state.form;
  if (f.isNew) {
    return `
      <div class="section">
        <div class="section-label">Photos ${f.pendingFiles.length ? `(${f.pendingFiles.length})` : ''}</div>
        <div class="photo-grid">
          ${f.pendingFiles.map((p,i) => `
            <div class="photo-tile">
              <img src="${p.previewUrl}" alt="" onclick="openLightbox('${p.previewUrl}')"/>
              <button class="photo-remove" onclick="removeFormPendingPhoto(${i})">&times;</button>
            </div>
          `).join('')}
        </div>
        <div class="add-photo-row ${f.pendingFiles.length ? 'compact' : ''}">
          <button class="add-photo-tile ${f.pendingFiles.length ? '' : 'big'}" onclick="openCamera()">${ICONS.camera}<span>${f.pendingFiles.length ? 'Camera' : 'Take Photo'}</span></button>
          <button class="add-photo-tile ${f.pendingFiles.length ? '' : 'big'}" onclick="openGallery()">${ICONS.gallery}<span>Upload</span></button>
        </div>
        ${!f.pendingFiles.length ? `<div class="section-hint">At least one photo is required.</div>` : ''}
      </div>`;
  }
  const nonCad = f.photos.filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  return `
    <div class="section">
      <div class="section-label">Photos ${nonCad.length ? `(${nonCad.length})` : ''}</div>
      <div class="photo-manage-list">
        ${nonCad.map((p,i) => `
          <div class="photo-manage-row">
            <img class="photo-manage-thumb" src="${p.thumb_path||p.path}" alt="" onclick="openLightbox('${p.path}')"/>
            <div class="photo-manage-info">
              <div class="photo-manage-label">${i===0 ? 'Main photo' : 'Photo ' + (i+1)}</div>
              <select onchange="setFormPhotoRole(${p.id}, this.value)">
                <option value="reference" ${p.role!=='detail'&&p.role!=='cad'?'selected':''}>Reference</option>
                <option value="detail" ${p.role==='detail'?'selected':''}>Detail crop</option>
                <option value="cad" ${p.role==='cad'?'selected':''}>CAD sheet</option>
              </select>
            </div>
            <div class="photo-manage-actions">
              <button class="photo-mini-btn" onclick="moveFormPhoto(${i}, -1)" ${i===0?'disabled':''}>&#8593;</button>
              <button class="photo-mini-btn" onclick="moveFormPhoto(${i}, 1)" ${i===nonCad.length-1?'disabled':''}>&#8595;</button>
              <button class="photo-mini-btn danger" onclick="removeFormPhoto(${p.id})">&times;</button>
            </div>
          </div>
        `).join('') || `<div class="section-hint">No photos yet.</div>`}
      </div>
      <div class="add-photo-row compact" style="margin-top:12px;">
        <button class="add-photo-tile" onclick="openCamera()">${ICONS.camera}<span>Camera</span></button>
        <button class="add-photo-tile" onclick="openGallery()">${ICONS.gallery}<span>Upload</span></button>
      </div>
    </div>`;
}

// Plain text/textarea fields with no cross-field wiring - oninput writes
// straight into state.form.concept on every keystroke (not just onchange),
// so a re-render triggered by anything else (switching tabs, adding a
// photo, picking a fabric) always rebuilds from up-to-date state instead of
// losing whatever's mid-typed elsewhere on the form.
function formTextareaField(key, label){
  const v = state.form.concept[key] || '';
  // Print/Embroidery-Applique also drive the fabric-report-requirement
  // banner - state.form.concept is already kept live on every keystroke
  // (see updateFormField), so the banner patch just re-reads it.
  const extra = (key === 'print' || key === 'embroidery_applique') ? `; updateFabricReportRequirementMobile()` : '';
  return `<div class="field"><label>${label}</label><textarea id="mf-${key}" oninput="updateFormField('${key}', this.value)${extra}">${esc(v)}</textarea></div>`;
}
function updateFormField(key, value){
  if (state.form) state.form.concept[key] = value;
}

// Factory dropdown sourced from Contacts' Factory-position company names
// (see state.factoryNames / loadLookupData) - mirrors desktop's
// renderConceptFactorySelect in public/js/concepts.js, including keeping
// an existing-but-unmatched value selectable rather than dropping it.
function renderFactorySelect(current){
  const names = state.factoryNames || [];
  const known = names.includes(current);
  const opts = [`<option value="">-</option>`];
  if (current && !known) opts.push(`<option value="${esc(current)}" selected>${esc(current)} (not in Contacts)</option>`);
  names.forEach(n => opts.push(`<option value="${esc(n)}" ${n===current?'selected':''}>${esc(n)}</option>`));
  return `<select id="mf-factory" onchange="updateFormField('factory', this.value)">${opts.join('')}</select>`;
}

// Whenever a concept has Print or Embroidery/Applique details, an
// additional Print/Embellishment fabric report is required on top of the
// base/bulk fabric report - same reminder as desktop's
// conceptNeedsPrintReport(), just a reminder, not an automated check
// against what's actually been uploaded.
function conceptNeedsPrintReportMobile(c){
  return !!((c.print && c.print.trim()) || (c.embroidery_applique && c.embroidery_applique.trim()));
}
function renderFabricReportRequirementMobile(needsReport){
  return needsReport
    ? `<div class="section-hint" style="color:var(--stitch-red);font-weight:700;">An additional Print/Embellishment fabric report is required, on top of the base fabric report.</div>`
    : `<div class="section-hint">No print or embroidery/applique details entered - the base fabric report is sufficient.</div>`;
}
function updateFabricReportRequirementMobile(){
  const el = document.getElementById('mf-fabric-report-requirement');
  if (el) el.innerHTML = renderFabricReportRequirementMobile(conceptNeedsPrintReportMobile(state.form.concept));
}

function renderFormDetailsSection(){
  const c = state.form.concept;
  const fabricOptions = (state.fabrics||[]).map(fab => `<option value="${esc(fab.code)}" ${c.fabric_code===fab.code?'selected':''}>${esc(fab.code)}</option>`).join('');
  const sizeOptions = (state.sizeRanges||[]).map(r => `<option value="${r.id}" ${String(c.size_range_id||'')===String(r.id)?'selected':''}>${esc(r.values.join(' / '))}</option>`).join('');
  return `
    <div class="section">
      <div class="section-label">Description <span style="font-weight:400;text-transform:none;">(optional)</span></div>
      <textarea class="desc-input" oninput="updateFormField('description', this.value)">${esc(c.description)}</textarea>
    </div>

    <div class="section">
      <div class="section-label">Department</div>
      <div class="field">
        <select id="mf-department" onchange="onFormDeptChange(this.value)">
          ${DEPARTMENTS.map(d => `<option value="${d}" ${c.department===d?'selected':''}>${d}</option>`).join('')}
        </select>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Fabric</div>
      <div class="field">
        <select id="mf-fabric_code" onchange="onFormFabricPicked(this.value)">
          <option value="">-</option>
          ${fabricOptions}
        </select>
      </div>
      <div class="field" style="margin-top:10px;"><label>Composition</label><input id="mf-composition" value="${esc(c.composition)}" oninput="updateFormField('composition', this.value)"/></div>
      <div class="field" style="margin-top:10px;"><label>Weight (oz)</label><input id="mf-weight" value="${esc(c.weight)}" oninput="updateFormField('weight', this.value)"/></div>
    </div>

    <div class="section">
      <div class="section-label">Construction</div>
      ${formTextareaField('wash','Wash')}
      ${formTextareaField('colour','Colour')}
      ${formTextareaField('print','Print')}
      ${formTextareaField('embroidery_applique','Embroidery / Applique')}
      <div id="mf-fabric-report-requirement">${renderFabricReportRequirementMobile(conceptNeedsPrintReportMobile(c))}</div>
      ${formTextareaField('topstitching','Topstitching')}
      ${formTextareaField('trims','Trims')}
      ${formTextareaField('styling','Styling')}
    </div>

    <div class="section">
      <div class="section-label">Spec</div>
      ${renderFormSpecSelector(c.department, state.form.specCategoryId)}
    </div>

    <div class="section">
      <div class="field"><label>Units</label><input id="mf-units" value="${esc(c.units)}" oninput="updateFormField('units', this.value)"/></div>
    </div>

    <div class="section">
      <div class="section-label">Sizes</div>
      <div class="field">
        <select id="mf-size_range_id" onchange="updateFormField('size_range_id', this.value)">
          <option value="">-</option>
          ${sizeOptions}
        </select>
      </div>
      <button class="btn-link" style="margin-top:8px;" onclick="openSpecOrSizeAdminFromForm('size')">Manage size ranges</button>
    </div>

    <div class="section">
      ${formTextareaField('packing','Packing')}
      ${formTextareaField('labels','Labels')}
    </div>

    <div class="section">
      <div class="section-label">Source</div>
      <div class="field">
        <select id="mf-source" onchange="updateFormField('source', this.value)">
          <option value="" ${!c.source?'selected':''}>-</option>
          <option value="Buyer photo" ${c.source==='Buyer photo'?'selected':''}>Buyer photo</option>
          <option value="In-house sample" ${c.source==='In-house sample'?'selected':''}>In-house sample</option>
          <option value="Bought-in reference" ${c.source==='Bought-in reference'?'selected':''}>Bought-in reference</option>
        </select>
      </div>
    </div>

    <div class="section">
      <div class="field"><label>Tags (comma separated)</label><input id="mf-tags" value="${esc(c.tags)}" oninput="updateFormField('tags', this.value)"/></div>
    </div>

    <div class="section">
      <div class="field"><label>Concept date</label><input type="month" id="mf-concept_date" value="${esc(c.concept_date)}" oninput="updateFormField('concept_date', this.value)"/></div>
    </div>

    <div class="section">
      <div class="field"><label>Factory</label>${renderFactorySelect(c.factory)}</div>
    </div>

    <div class="section">
      <div class="field"><label>DC Date</label><input type="date" id="mf-dc_date" value="${esc(c.dc_date)}" oninput="updateConceptDcDate(this.value)"/></div>
      <div class="field" style="margin-top:10px;"><label>Shipping Date</label><input type="date" id="mf-shipping_date" value="${esc(c.shipping_date)}" oninput="updateFormField('shipping_date', this.value)"/></div>
      <div class="section-hint">Shipping Date is set automatically to 55 days before DC Date - editable afterward if it needs adjusting.</div>
    </div>
  `;
}
// DC Date is the one actually set by hand - Shipping Date defaults to 55
// days before it, same live-default-stays-editable pattern as desktop's
// updateConceptShippingDateFromDc.
function updateConceptDcDate(value){
  updateFormField('dc_date', value);
  if (!value) return;
  const d = new Date(value + 'T00:00:00');
  d.setDate(d.getDate() - 55);
  const shipping = d.toISOString().slice(0, 10);
  updateFormField('shipping_date', shipping);
  const el = document.getElementById('mf-shipping_date');
  if (el) el.value = shipping;
}

function onFormDeptChange(d){
  state.form.concept.department = d;
  state.form.specCategoryId = null; // a different department is a different spec tree
  render();
}

// Live lookup against the already-loaded fabrics list, same pattern as
// desktop's onConceptFabricPicked() - unconditionally overwrites
// composition/weight on pick, both stay freely editable afterward.
function onFormFabricPicked(code){
  const c = state.form.concept;
  c.fabric_code = code;
  const fab = (state.fabrics||[]).find(f => f.code === code);
  if (fab) {
    c.composition = fab.composition || '';
    c.weight = fab.weight || '';
  }
  render();
}

// Cascading Spec picker - one <select> per tree level, populated with the
// children of whatever was picked one level up, stopping at a leaf. Mirrors
// public/js/specCategories.js's renderSpecSelector()/onSpecLevelChange()
// exactly, just reading/writing state.form instead of state.conceptDrawer.
function renderFormSpecSelector(department, selectedId){
  const nodes = (state.specCategories||[]).filter(n => n.department === department);
  if (!nodes.length) {
    return `<div class="section-hint">No spec categories yet for ${esc(department)}.</div>
      <button class="btn-link" style="margin-top:8px;" onclick="openSpecOrSizeAdminFromForm('spec')">Manage spec hierarchy</button>`;
  }
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  let chain = [];
  if (selectedId && byId[selectedId]) {
    let cur = byId[selectedId];
    chain.unshift(cur.id);
    while (cur.parent_id) { cur = byId[cur.parent_id]; if (!cur) break; chain.unshift(cur.id); }
  }
  const selects = [];
  let parentId = null;
  let level = 0;
  while (true) {
    const options = nodes.filter(n => n.parent_id === parentId).sort((a,b) => (a.sort_order-b.sort_order) || a.name.localeCompare(b.name));
    if (!options.length) break;
    const chosen = chain[level] || '';
    selects.push(`
      <div class="field" style="margin-top:${level ? 10 : 0}px;">
        <select onchange="onFormSpecLevelChange(${level}, this.value)">
          <option value="">Select...</option>
          ${options.map(o => `<option value="${o.id}" ${String(chosen)===String(o.id)?'selected':''}>${esc(o.name)}${level===0?' ('+esc(o.retailer)+')':''}</option>`).join('')}
        </select>
      </div>
    `);
    if (!chosen) break;
    parentId = Number(chosen);
    level++;
  }
  return selects.join('') + `<button class="btn-link" style="margin-top:8px;" onclick="openSpecOrSizeAdminFromForm('spec')">Manage spec hierarchy</button>`;
}
function onFormSpecLevelChange(level, value){
  const nodes = state.specCategories || [];
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  let chain = [];
  if (state.form.specCategoryId && byId[state.form.specCategoryId]) {
    let cur = byId[state.form.specCategoryId];
    chain.unshift(cur.id);
    while (cur.parent_id) { cur = byId[cur.parent_id]; if (!cur) break; chain.unshift(cur.id); }
  }
  chain = chain.slice(0, level);
  if (value) chain.push(Number(value));
  state.form.specCategoryId = chain.length ? chain[chain.length-1] : null;
  render();
}

// Margin the buyer makes = (RSP - what they pay us) / RSP. Buyer Rand Target
// is entered ex VAT, but RSP is VAT-inclusive (what the shopper pays), so
// VAT (15%) is added to the rand figure before comparing the two - same
// calc as desktop's computeConceptMargin(). Purely derived, never stored on
// its own - just recomputed for display, live as either field changes.
// Patches only the display span so typing here never risks losing anything
// typed elsewhere on the form.
const VAT_RATE = 0.15;
function computeFormMargin(rand, rsp){
  const r = parseFloat(rand), s = parseFloat(rsp);
  if (!r || !s || isNaN(r) || isNaN(s)) return null;
  const randInclVat = r * (1 + VAT_RATE);
  return ((s - randInclVat) / s) * 100;
}
function formatFormMargin(rand, rsp){
  const m = computeFormMargin(rand, rsp);
  return m === null ? '—' : m.toFixed(1) + '%';
}
function updateFormMargin(){
  updateFormField('buyer_rand_target', document.getElementById('mf-buyer_rand_target').value);
  updateFormField('buyer_rsp_target', document.getElementById('mf-buyer_rsp_target').value);
  const el = document.getElementById('mf-margin-display');
  if (el) el.textContent = formatFormMargin(state.form.concept.buyer_rand_target, state.form.concept.buyer_rsp_target);
}

function renderFormCostsSection(){
  const c = state.form.concept;
  return `
    <div class="section">
      <div class="field"><label>Cost estimate (R)</label><input id="mf-cost_estimate" value="${esc(c.cost_estimate)}" oninput="updateFormField('cost_estimate', this.value)"/></div>
    </div>
    <div class="section">
      <div class="field"><label>Buyer Rand Target</label><input id="mf-buyer_rand_target" value="${esc(c.buyer_rand_target)}" oninput="updateFormMargin()"/></div>
      <div class="field" style="margin-top:10px;"><label>Buyer RSP Target</label><input id="mf-buyer_rsp_target" value="${esc(c.buyer_rsp_target)}" oninput="updateFormMargin()"/></div>
    </div>
    <div class="section">
      <div class="section-label">% Margin</div>
      <div id="mf-margin-display" style="font-family:'Oswald',sans-serif;font-size:26px;font-weight:700;color:var(--denim-deep);">${formatFormMargin(c.buyer_rand_target, c.buyer_rsp_target)}</div>
      <div class="section-hint">The % margin the buyer makes, from Buyer Rand Target (ex VAT, 15% added for this calc) vs Buyer RSP Target - recalculates as you type, nothing saved separately.</div>
    </div>
    <div class="section">
      <div class="field"><label>Factory Target $ Price</label><input id="mf-factory_target_price" value="${esc(c.factory_target_price)}" oninput="updateFormField('factory_target_price', this.value)"/></div>
      <div class="field" style="margin-top:10px;"><label>Factory $ Price</label><input id="mf-factory_price" value="${esc(c.factory_price)}" oninput="updateFormField('factory_price', this.value)"/></div>
    </div>
    <div class="section">
      ${formTextareaField('factory_cost_options', 'Factory Cost Options')}
      <div class="section-hint">Cheaper alternatives the factory offered against the target price, e.g. "$7.00 without back pockets" or "$6.80 with an enzyme wash instead of acid wash and no turn-up hem".</div>
    </div>
  `;
}

function renderFormCadSection(){
  const f = state.form;
  const cadPhoto = f.photos.find(p => p.role === 'cad');
  return `
    <div class="section">
      <div class="section-label">Main CAD Image</div>
      ${cadPhoto ? `
        <div class="cad-preview-box" onclick="openLightbox('${cadPhoto.path}')">
          <img src="${cadPhoto.path}" alt=""/>
        </div>
        <button class="btn-link" style="margin-top:8px;color:var(--stitch-red);" onclick="deleteFormCadPhoto(${cadPhoto.id})">Delete CAD image</button>
      ` : `<div class="cad-placeholder">No CAD image yet</div>`}
      <div class="add-photo-row compact" style="margin-top:12px;">
        <button class="add-photo-tile" ${f.cadBusy ? 'disabled' : ''} onclick="generateOrRegenerateFormCad()">${ICONS.camera}<span>${f.cadBusy ? 'Working...' : (cadPhoto ? 'Regenerate AI' : 'Generate AI')}</span></button>
        <button class="add-photo-tile" onclick="document.getElementById('cadFileInput').click()">${ICONS.gallery}<span>Upload</span></button>
      </div>
      <div class="section-hint">AI generation uses the first two reference photos from Details as front/back. This can take up to a minute.</div>
    </div>
    ${cadPhoto ? `
      <div class="section">
        <button class="btn-block ghost" onclick="previewFormCadSheet()">Preview CAD sheet</button>
        <button class="btn-block primary" style="margin-top:10px;" onclick="downloadFormCadFile()">Download CAD file</button>
        ${f.cadPreview ? `<img src="${f.cadPreview.dataUrl}" alt="" style="width:100%;border-radius:8px;margin-top:12px;border:1px solid var(--line);"/>` : ''}
      </div>
    ` : ''}
  `;
}

function setFormTab(tab){
  state.form.tab = tab;
  render();
}
function closeForm(){
  history.back();
}

// From a "Manage spec hierarchy"/"Manage size ranges" link inside the form -
// opens the relevant admin screen without discarding the in-progress form
// (the browser back button returns straight to it, form state untouched
// since state.form is never cleared by opening the admin screen).
function openSpecOrSizeAdminFromForm(which){
  if (which === 'spec') openSpecAdmin(state.form.concept.department);
  else openSizeAdmin();
}

// ---- Photo management (create: staged pendingFiles; edit: real photos) ----

function removeFormPendingPhoto(i){
  const p = state.form.pendingFiles[i];
  if (p) URL.revokeObjectURL(p.previewUrl);
  state.form.pendingFiles.splice(i, 1);
  render();
}

async function uploadFormPhotos(files){
  if (!files.length) return;
  const form = new FormData();
  files.forEach(f => form.append('photos', f));
  try {
    const res = await fetch(`/api/concepts/${state.form.id}/photos`, { method:'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.form.photos = data.photos;
    render();
  } catch(e) { showToast(e.message); }
}

async function removeFormPhoto(photoId){
  if (!confirm('Remove this photo?')) return;
  try {
    const res = await fetch(`/api/concepts/${state.form.id}/photos/${photoId}`, { method:'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not remove photo');
    state.form.photos = data.photos;
    render();
  } catch(e) { showToast(e.message); }
}

// Tap-based reorder (up/down) rather than drag, since drag-and-drop is
// unreliable on touch. Only reorders the reference/detail photos shown
// here - cad/cad_detail ones (managed on the CAD tab) keep their own
// sort_order untouched.
async function moveFormPhoto(index, delta){
  const f = state.form;
  const nonCad = f.photos.filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  const other = f.photos.filter(p => p.role === 'cad' || p.role === 'cad_detail');
  const toIdx = index + delta;
  if (toIdx < 0 || toIdx >= nonCad.length) return;
  const reordered = [...nonCad];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(toIdx, 0, moved);
  f.photos = [...reordered, ...other];
  render();
  try {
    const res = await fetch(`/api/concepts/${f.id}/photos/reorder`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: reordered.map(p => p.id) })
    });
    const data = await res.json();
    if (res.ok) { f.photos = data.photos; render(); }
  } catch(e) { showToast('Could not save new photo order'); }
}

async function setFormPhotoRole(photoId, role){
  try {
    const res = await fetch(`/api/concepts/${state.form.id}/photos/${photoId}/role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not update role');
    state.form.photos = data.photos;
    render();
  } catch(e) { showToast(e.message); }
}

// ---- CAD tab: view/generate/upload/preview/download ----
// Canvas-composited sheet logic below is a direct port of desktop's
// buildCadSheetDataUrl() (public/js/concepts.js) - same layout, same fonts,
// same backend endpoint - so a downloaded PDF looks identical either way.

function loadImageEl(src){
  return new Promise((resolve,reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
}
function drawContain(ctx, img, x, y, w, h){
  const scale = Math.min(w/img.width, h/img.height);
  const dw = img.width*scale, dh = img.height*scale;
  ctx.drawImage(img, x+(w-dw)/2, y+(h-dh)/2, dw, dh);
}
function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight){
  let curY = y;
  (text || '').split('\n').forEach(paragraph => {
    if (!paragraph.trim()) { curY += lineHeight; return; }
    const words = paragraph.split(/\s+/);
    let line = '';
    words.forEach(word => {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, curY); line = word; curY += lineHeight;
      } else { line = test; }
    });
    if (line) { ctx.fillText(line, x, curY); curY += lineHeight; }
  });
  return curY;
}
async function buildFormCadSheetDataUrl(){
  const f = state.form;
  const cadPhoto = f.photos.find(p => p.role === 'cad');
  if (!cadPhoto) return null;

  const canvas = document.createElement('canvas');
  canvas.width = 1900; canvas.height = 1000;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgAreaWidth = 1500;
  const cadImg = await loadImageEl(cadPhoto.path);
  drawContain(ctx, cadImg, 0, 0, imgAreaWidth, canvas.height);

  const sbX = imgAreaWidth + 60;
  const textMaxWidth = canvas.width - sbX - 60;
  const logoW = 200, logoH = logoW * (640 / 594);

  try {
    const logo = await loadImageEl('/img/E-Logo-concept.PNG');
    ctx.drawImage(logo, sbX, 70, logoW, logoH);
  } catch(e) { /* logo optional */ }

  ctx.fillStyle = '#1c2833';
  ctx.textAlign = 'left';
  ctx.font = 'bold 46px Oswald, sans-serif';
  ctx.fillText(f.concept_no, sbX, 70 + logoH + 70);
  ctx.font = '24px "IBM Plex Sans", sans-serif';
  wrapCanvasText(ctx, f.concept.description || '', sbX, 70 + logoH + 112, textMaxWidth, 32);

  return { dataUrl: canvas.toDataURL('image/png') };
}
async function previewFormCadSheet(){
  try {
    const built = await buildFormCadSheetDataUrl();
    if (!built) { showToast('Generate or upload a main CAD image first'); return; }
    state.form.cadPreview = built;
    render();
  } catch(e) { showToast('Could not build preview: ' + e.message); }
}
async function downloadFormCadFile(){
  try {
    const built = state.form.cadPreview || await buildFormCadSheetDataUrl();
    if (!built) { showToast('Generate or upload a main CAD image first'); return; }
    showToast('Building PDF...');
    const res = await fetch(`/api/concepts/${state.form.id}/export-cad-pdf`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: built.dataUrl })
    });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Export failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${state.form.concept_no}.pdf`; a.click();
    URL.revokeObjectURL(url);
    showToast('PDF downloaded');
  } catch(e) { showToast('Could not download CAD file: ' + e.message); }
}
async function generateOrRegenerateFormCad(){
  const f = state.form;
  const sourcePhotos = f.photos.filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (sourcePhotos.length < 2) { showToast('Add at least two reference photos first'); return; }
  f.cadBusy = true;
  render();
  try {
    const res = await fetch(`/api/concepts/${f.id}/generate-cad-ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoIds: [sourcePhotos[0].id, sourcePhotos[1].id] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'CAD generation failed');
    f.photos = data.photos;
    f.cadBusy = false;
    f.cadPreview = null;
    render();
    showToast('CAD generated');
  } catch(e) {
    f.cadBusy = false;
    render();
    showToast(e.message);
  }
}
async function uploadFormCadMain(file){
  const formData = new FormData();
  formData.append('photo', file);
  try {
    const res = await fetch(`/api/concepts/${state.form.id}/cad-main`, { method:'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.form.photos = data.photos;
    state.form.cadPreview = null;
    render();
    showToast('CAD image uploaded');
  } catch(e) { showToast(e.message); }
}
async function deleteFormCadPhoto(photoId){
  if (!confirm('Delete the generated CAD image? You can always generate a new one.')) return;
  try {
    const res = await fetch(`/api/concepts/${state.form.id}/photos/${photoId}`, { method:'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not delete');
    state.form.photos = data.photos;
    state.form.cadPreview = null;
    render();
  } catch(e) { showToast(e.message); }
}

// ---- Save / delete ----

async function submitForm(){
  const f = state.form;
  if (!f || f.submitting) return;
  if (!f.concept.department) { f.validationHint = 'Please select a department'; return render(); }
  if (f.isNew && !f.pendingFiles.length) { f.validationHint = 'Please take at least one photo'; return render(); }

  f.submitting = true;
  f.validationHint = '';
  f.error = '';
  render();

  if (f.isNew) {
    try {
      const formData = new FormData();
      Object.keys(f.concept).forEach(k => formData.append(k, f.concept[k] || ''));
      formData.append('spec_category_id', f.specCategoryId || '');

      const res = await fetch('/api/concepts', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not create the concept');

      const conceptId = data.concept.id;
      const conceptNo = data.concept.concept_no;
      const pending = f.pendingFiles;

      state.lastCreated = { concept_no: conceptNo, department: data.concept.department };
      state.concepts = []; // browse cache is now stale
      state.form = null;
      pushScreen('success');
      state.screen = 'success';
      render();

      // The concept itself is already saved at this point - upload its
      // photos in the background rather than making the merchandiser wait
      // ~10s for image processing before they can start the next concept.
      // autoCad=1 chains the same AI CAD generation the old create-time
      // flow fired, now triggered once these photos have actually landed.
      uploadPendingPhotosInBackground(conceptId, conceptNo, pending);
    } catch(e) {
      f.submitting = false;
      f.error = e.message || 'Could not reach the server';
      render();
    }
  } else {
    try {
      const body = { ...f.concept, spec_category_id: f.specCategoryId };
      const res = await fetch('/api/concepts/' + f.id, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save changes');
      f.submitting = false;
      state.concepts = []; // browse cache is now stale
      state.conceptDetail = null; // detail cache for this id is now stale
      showToast('Saved');
      history.back();
    } catch(e) {
      f.submitting = false;
      f.error = e.message || 'Could not reach the server';
      render();
    }
  }
}

// Fire-and-forget upload used right after a mobile "create" - the concept
// already exists, so a failure here just leaves it with no/partial photos
// rather than losing the whole concept. Surfaced via a toast since the
// merchandiser has typically already moved on to the next concept by the
// time this resolves; they can reopen it from Browse to add photos again.
async function uploadPendingPhotosInBackground(conceptId, conceptNo, pending){
  if (!pending.length) return;
  try {
    const photoData = new FormData();
    pending.forEach(p => photoData.append('photos', p.file, p.file.name || 'photo.jpg'));
    photoData.append('autoCad', '1');
    const res = await fetch(`/api/concepts/${conceptId}/photos`, { method: 'POST', body: photoData });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Photo upload failed');
    }
    if (state.form && state.form.id === conceptId) loadEditForm(conceptId);
    if (state.conceptDetail && state.conceptDetail.concept.id === conceptId) loadConceptDetail(conceptId);
  } catch(e) {
    showToast(`${conceptNo}: photo upload failed - reopen it from Browse to retry`);
  } finally {
    pending.forEach(p => URL.revokeObjectURL(p.previewUrl));
  }
}

async function deleteFormConcept(){
  const f = state.form;
  if (!confirm(`Permanently delete ${f.concept_no}? This removes its photos too, and can't be undone.`)) return;
  try {
    const res = await fetch('/api/concepts/' + f.id, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Could not delete'); }
    state.concepts = state.concepts.filter(c => c.id !== f.id);
    const conceptNo = f.concept_no;
    state.form = null;
    replaceScreen('browse');
    state.screen = 'browse';
    render();
    loadConcepts();
    showToast(`${conceptNo} deleted`);
  } catch(e) { showToast(e.message); }
}

function renderBrowse(){
  const filtered = state.browseFilter ? state.concepts.filter(c => c.department === state.browseFilter) : state.concepts;
  return `
  <div class="topbar">
    <button class="back-btn" onclick="goHome()">${ICONS.back}</button>
    <div class="topbar-title"><h1>Browse Concepts</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>

  <div class="form-scroll">
    <div class="row-actions-mobile">
      <button class="btn-link" onclick="openSpecAdmin()">Manage Spec Hierarchy</button>
      <button class="btn-link" onclick="openSizeAdmin()">Manage Size Ranges</button>
    </div>
    <div class="field">
      <select onchange="selectBrowseFilter(this.value)">
        <option value="" ${!state.browseFilter ? 'selected' : ''}>All departments</option>
        ${DEPARTMENTS.map(d => `<option value="${d}" ${state.browseFilter===d?'selected':''}>${d}</option>`).join('')}
      </select>
    </div>

    ${state.conceptsLoading ? `<div class="spinner" style="margin-top:40px;"></div>` : ''}
    ${state.conceptsError ? `<div class="error-msg" style="margin-top:16px;">${esc(state.conceptsError)}</div>` : ''}
    ${!state.conceptsLoading && !state.conceptsError && filtered.length === 0 ? `<div class="section-hint" style="margin-top:20px;">No concepts found.</div>` : ''}

    <div class="concept-list">
      ${filtered.map(c => `
        <button class="concept-card" onclick="openConceptFromBrowse(${c.id})">
          <div class="concept-thumb">${c.cover_photo ? `<img src="${c.cover_photo}" alt=""/>` : `<div class="concept-thumb-empty">${ICONS.gallery}</div>`}</div>
          <div class="concept-info">
            <div class="concept-no-label">${esc(c.concept_no)}</div>
            <div class="concept-dept">${esc(c.department)}</div>
            ${c.description ? `<div class="concept-desc">${esc(c.description)}</div>` : ''}
          </div>
        </button>
      `).join('')}
    </div>
  </div>`;
}

function renderDetail(){
  const d = state.conceptDetail;
  const canEdit = state.user.role !== 'buyer';
  return `
  <div class="topbar">
    <button class="back-btn" onclick="closeDetail()">${ICONS.back}</button>
    <div class="topbar-title"><h1>${d ? esc(d.concept.concept_no) : 'Concept'}</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>

  <div class="form-scroll">
    ${state.conceptDetailLoading ? `<div class="spinner" style="margin-top:40px;"></div>` : ''}
    ${state.conceptDetailError ? `<div class="error-msg" style="margin-top:16px;">${esc(state.conceptDetailError)}</div>` : ''}
    ${d ? `
      <div class="detail-header">
        <span class="chip selected" style="pointer-events:none;">${esc(d.concept.department)}</span>
      </div>
      ${d.concept.description ? `<p class="detail-desc">${esc(d.concept.description)}</p>` : ''}

      <div class="detail-fields">
        ${detailField('Fabric', d.concept.fabric_code)}
        ${detailField('Composition', d.concept.composition)}
        ${detailField('Weight', d.concept.weight ? d.concept.weight + ' oz' : null)}
        ${detailField('Spec', specPathLabel(d.concept.spec_category_id))}
        ${detailField('Sizes', sizeRangeLabel(d.concept.size_range_id))}
        ${detailField('Units', d.concept.units)}
        ${detailField('Source', d.concept.source)}
        ${detailField('Tags', d.concept.tags)}
        ${detailField('Concept Date', formatMonth(d.concept.concept_date))}
        ${detailField('Cost Estimate', d.concept.cost_estimate ? 'R' + d.concept.cost_estimate : null)}
        ${detailField('Factory', d.concept.factory)}
        ${detailField('DC Date', d.concept.dc_date)}
        ${detailField('Shipping Date', d.concept.shipping_date)}
      </div>

      ${d.conversions && d.conversions.length ? `
        <div class="section-label" style="margin-top:20px;">Converted To</div>
        <div class="chip-grid">
          ${d.conversions.map(c => `<span class="chip selected" style="pointer-events:none;">${esc(c.style_no)}</span>`).join('')}
        </div>
      ` : ''}

      <div class="section-label" style="margin-top:22px;">Photos ${d.photos.length ? `(${d.photos.length})` : ''}</div>
      <div class="photo-grid">
        ${d.photos.map(p => `
          <button class="photo-tile view-only" onclick="openLightbox('${p.path}')">
            <img src="${p.thumb_path || p.path}" alt=""/>
            ${photoBadge(p)}
          </button>
        `).join('')}
      </div>
      ${!d.photos.length ? `<div class="section-hint">No photos on this concept.</div>` : ''}

      ${canEdit ? `<button class="btn-block primary" style="margin-top:24px;" onclick="openEditConcept(${d.concept.id})">Edit Concept</button>` : ''}
    ` : ''}
  </div>`;
}

function renderSuccess(){
  const c = state.lastCreated;
  return `
  <div class="success-screen">
    <div class="success-check">${ICONS.check}</div>
    <div class="label">Concept Created</div>
    <div class="concept-no">${esc(c.concept_no)}</div>
    <div class="dept">${esc(c.department)}</div>
    <div class="actions">
      <button class="btn-block primary" onclick="resetForm('create')">Add Another Concept</button>
      <button class="btn-block ghost" onclick="resetForm('home')">Back to Home</button>
    </div>
  </div>`;
}

function renderLightbox(){
  if (!state.lightboxUrl) return '';
  return `
  <div class="lightbox" onclick="closeLightbox()">
    <button class="lightbox-close" onclick="closeLightbox()">${ICONS.close}</button>
    <img src="${state.lightboxUrl}" onclick="event.stopPropagation()"/>
  </div>`;
}

// ---- Spec Hierarchy admin screen ----
// Mirrors public/js/specCategories.js's manager drawer, as its own screen.

function renderSpecAdmin(){
  const a = state.specAdmin || { retailer: RETAILERS[0], department: DEPARTMENTS[0] };
  const nodes = (state.specCategories||[]).filter(n => n.department === a.department && n.retailer === a.retailer);
  return `
  <div class="topbar">
    <button class="back-btn" onclick="closeSpecAdmin()">${ICONS.back}</button>
    <div class="topbar-title"><h1>Spec Hierarchy</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>
  <div class="form-scroll">
    <div class="chip-grid">
      ${RETAILERS.map(r => `<button class="chip ${a.retailer===r?'selected':''}" onclick="setSpecAdminRetailer('${r}')">${r}</button>`).join('')}
    </div>
    <div class="chip-grid" style="margin-top:8px;">
      ${DEPARTMENTS.map(d => `<button class="chip ${a.department===d?'selected':''}" onclick="setSpecAdminDept('${d}')">${d}</button>`).join('')}
    </div>
    <div class="section" style="margin-top:18px;">
      ${nodes.length ? renderSpecAdminTree(nodes, null, 0) : `<div class="section-hint">No spec categories yet for ${esc(a.retailer)} / ${esc(a.department)}.</div>`}
      <button class="btn-block ghost" style="margin-top:14px;" onclick="addSpecRootMobile('${esc(a.retailer)}','${esc(a.department)}')">+ Add top-level category</button>
    </div>
  </div>`;
}
function renderSpecAdminTree(nodes, parentId, depth){
  const children = nodes.filter(n => n.parent_id === parentId).sort((a,b) => (a.sort_order-b.sort_order) || a.name.localeCompare(b.name));
  if (!children.length) return '';
  return `<div style="margin-left:${depth ? 16 : 0}px;">
    ${children.map(n => `
      <div class="spec-admin-row">
        <span class="spec-admin-name">${esc(n.name)}</span>
        <div class="spec-admin-actions">
          <button class="photo-mini-btn" onclick="addSpecChildMobile(${n.id})">+</button>
          <button class="photo-mini-btn" onclick="renameSpecMobile(${n.id})">&#9998;</button>
          <button class="photo-mini-btn danger" onclick="deleteSpecMobile(${n.id})">&times;</button>
        </div>
      </div>
      ${renderSpecAdminTree(nodes, n.id, depth+1)}
    `).join('')}
  </div>`;
}
function setSpecAdminDept(d){ state.specAdmin.department = d; render(); }
function setSpecAdminRetailer(r){ state.specAdmin.retailer = r; render(); }
async function addSpecRootMobile(retailer, department){
  const name = prompt(`New top-level category under ${retailer} / ${department}:`);
  if (!name || !name.trim()) return;
  try {
    const res = await fetch('/api/spec-categories', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ retailer, department, name: name.trim() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add category');
    state.specCategories.push(data.category);
    render();
  } catch(e) { showToast(e.message); }
}
async function addSpecChildMobile(parentId){
  const name = prompt('New sub-category name:');
  if (!name || !name.trim()) return;
  try {
    const res = await fetch('/api/spec-categories', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ parent_id: parentId, name: name.trim() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add category');
    state.specCategories.push(data.category);
    render();
  } catch(e) { showToast(e.message); }
}
async function renameSpecMobile(id){
  const node = (state.specCategories||[]).find(n => n.id === id);
  if (!node) return;
  const name = prompt('Rename category:', node.name);
  if (!name || !name.trim() || name.trim() === node.name) return;
  try {
    const res = await fetch('/api/spec-categories/'+id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: name.trim() }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not rename');
    const idx = state.specCategories.findIndex(n => n.id === id);
    if (idx !== -1) state.specCategories[idx] = data.category;
    render();
  } catch(e) { showToast(e.message); }
}
async function deleteSpecMobile(id){
  const node = (state.specCategories||[]).find(n => n.id === id);
  if (!node) return;
  if (!confirm(`Delete "${node.name}" and everything under it? This can't be undone, and any concept using it will have its spec cleared.`)) return;
  try {
    const res = await fetch('/api/spec-categories/'+id, { method:'DELETE' });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Could not delete'); }
    const res2 = await fetch('/api/spec-categories');
    if (res2.ok) state.specCategories = (await res2.json()).categories;
    render();
  } catch(e) { showToast(e.message); }
}
function openSpecAdmin(department){
  state.specAdmin = { retailer: RETAILERS[0], department: department || DEPARTMENTS[0] };
  pushScreen('spec-admin');
  state.screen = 'specAdmin';
  render();
}
function closeSpecAdmin(){ history.back(); }

// ---- Size Range admin screen ----

function renderSizeAdmin(){
  const ranges = state.sizeRanges || [];
  return `
  <div class="topbar">
    <button class="back-btn" onclick="closeSizeAdmin()">${ICONS.back}</button>
    <div class="topbar-title"><h1>Size Ranges</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>
  <div class="form-scroll">
    ${ranges.length ? `
      <div class="detail-fields">
        ${ranges.map(r => `
          <div class="detail-field-row">
            <span class="detail-field-value" style="text-align:left;">${esc(r.values.join(' / '))}</span>
            <button class="photo-mini-btn danger" onclick="deleteSizeRangeMobile(${r.id})">&times;</button>
          </div>
        `).join('')}
      </div>
    ` : `<div class="section-hint">No size ranges yet.</div>`}
    <div class="section" style="margin-top:18px;">
      <div class="field"><label>New size range (comma separated, in order)</label><input id="new-size-range-mobile" placeholder="e.g. S, M, L, XL"/></div>
      <button class="btn-block primary" style="margin-top:10px;" onclick="addSizeRangeMobile()">+ Add size range</button>
    </div>
  </div>`;
}
async function addSizeRangeMobile(){
  const el = document.getElementById('new-size-range-mobile');
  const values = el.value.split(',').map(v => v.trim()).filter(Boolean);
  if (!values.length) { showToast('Enter at least one size value'); return; }
  try {
    const res = await fetch('/api/size-ranges', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ values }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not add range');
    state.sizeRanges.push(data.range);
    render();
  } catch(e) { showToast(e.message); }
}
async function deleteSizeRangeMobile(id){
  if (!confirm('Delete this size range? Any concept using it will have its sizes cleared.')) return;
  try {
    const res = await fetch('/api/size-ranges/'+id, { method:'DELETE' });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Could not delete'); }
    state.sizeRanges = state.sizeRanges.filter(r => r.id !== id);
    render();
  } catch(e) { showToast(e.message); }
}
function openSizeAdmin(){
  pushScreen('size-admin');
  state.screen = 'sizeAdmin';
  render();
}
function closeSizeAdmin(){ history.back(); }

// Shown above everything else so a merchandiser opening a shared link can
// add the app to their home screen immediately, without hunting through the
// browser menu. Android/Chrome gets a real one-tap install via the captured
// beforeinstallprompt event; iOS Safari has no programmatic install API, so
// it gets a "tap Share, then Add to Home Screen" instruction instead.
function renderInstallBanner(){
  if (state.isStandalone || state.installBannerDismissed || state.screen === 'loading') return '';
  if (state.installPromptEvent) {
    return `
    <div class="install-banner">
      <div class="install-banner-icon">${ICONS.install}</div>
      <div class="install-banner-text"><strong>Install Elanzas</strong><span>Add to your home screen for quick access</span></div>
      <button class="install-banner-btn" onclick="triggerInstall()">Install</button>
      <button class="install-banner-close" onclick="dismissInstallBanner()">${ICONS.close}</button>
    </div>`;
  }
  if (state.isIOS) {
    return `
    <div class="install-banner">
      <div class="install-banner-icon">${ICONS.install}</div>
      <div class="install-banner-text"><strong>Install Elanzas</strong><span>Tap the Share icon, then "Add to Home Screen"</span></div>
      <button class="install-banner-close" onclick="dismissInstallBanner()">${ICONS.close}</button>
    </div>`;
  }
  return '';
}

function render(){
  const app = document.getElementById('app');
  let html = '';
  if (state.screen === 'loading') html = renderLoading();
  else if (state.screen === 'login') html = renderLogin();
  else if (state.screen === 'home') html = renderHome();
  else if (state.screen === 'form') html = renderFormScreen();
  else if (state.screen === 'browse') html = renderBrowse();
  else if (state.screen === 'detail') html = renderDetail();
  else if (state.screen === 'success') html = renderSuccess();
  else if (state.screen === 'specAdmin') html = renderSpecAdmin();
  else if (state.screen === 'sizeAdmin') html = renderSizeAdmin();
  app.innerHTML = renderInstallBanner() + html + renderLightbox();

  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', (e) => { e.preventDefault(); login(); });
}

// ---- Auth ----

async function checkSession(){
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { state.screen = 'login'; return render(); }
    const data = await res.json();
    state.user = data.user;
    state.screen = 'home';
    replaceScreen('home');
    if (hasConceptsPermission()) loadLookupData();
  } catch (e) {
    state.screen = 'login';
  }
  render();
}

async function login(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  state.loginBusy = true;
  state.loginError = '';
  render();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      state.loginError = data.error || 'Invalid email or password';
      state.loginBusy = false;
      return render();
    }
    state.user = data.user;
    state.loginBusy = false;
    state.screen = 'home';
    replaceScreen('home');
    if (hasConceptsPermission()) loadLookupData();
    render();
  } catch (e) {
    state.loginError = 'Could not reach the server';
    state.loginBusy = false;
    render();
  }
}

async function logout(){
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  if (state.form) (state.form.pendingFiles||[]).forEach(p => URL.revokeObjectURL(p.previewUrl));
  state.user = null;
  state.form = null;
  state.lastCreated = null;
  state.fabrics = [];
  state.specCategories = [];
  state.sizeRanges = [];
  state.specAdmin = null;
  state.concepts = [];
  state.conceptsError = '';
  state.browseFilter = '';
  state.conceptDetail = null;
  state.conceptDetailError = '';
  state.lightboxUrl = null;
  state.screen = 'login';
  history.replaceState(null, '', location.pathname);
  render();
}

// Fetched once after login (and again after any spec/size-range admin
// change) - the create/edit form's Fabric/Spec/Sizes fields and the
// read-only detail view's Spec/Sizes labels all read from these.
async function loadLookupData(){
  try {
    // Factory names 403 for buyer role (they never see the Factory field,
    // stripped server-side) - fetched anyway and just ignored on failure,
    // simpler than threading role into this shared loader.
    const [specRes, sizeRes, fabRes, factoryRes] = await Promise.all([
      fetch('/api/spec-categories'), fetch('/api/size-ranges'), fetch('/api/fabrics'), fetch('/api/concepts/factory-names')
    ]);
    if (specRes.ok) state.specCategories = (await specRes.json()).categories;
    if (sizeRes.ok) state.sizeRanges = (await sizeRes.json()).ranges;
    if (fabRes.ok) state.fabrics = (await fabRes.json()).fabrics;
    if (factoryRes.ok) state.factoryNames = (await factoryRes.json()).factories;
    render();
  } catch(e) { /* non-critical - forms just show empty dropdowns until this succeeds */ }
}

// ---- Navigation ----
//
// The phone's hardware/gesture back button fires the browser's native
// back/forward navigation, not any code of ours - the only way to hook into
// it is via the History API. Each in-app screen gets a real history entry
// (as a URL hash) when navigated to going "forward" (the various open*
// functions), and a 'popstate' listener re-derives state.screen from
// whatever hash the user lands on when they go back/forward - including via
// the hardware button. In-app back arrows call history.back() instead of
// navigating directly, so they produce the exact same popstate event and
// stay perfectly in sync with the hardware button rather than growing a
// parallel, divergent stack.

function pushScreen(hash){
  if (location.hash !== '#' + hash) history.pushState({ screen: hash }, '', '#' + hash);
}
function replaceScreen(hash){
  history.replaceState({ screen: hash }, '', '#' + hash);
}

function applyScreenFromHash(hash){
  if (!state.user) return; // still on login/loading - hash routing doesn't apply yet
  if (hash === 'create') {
    if (!state.form || !state.form.isNew) state.form = blankFormState(true);
    state.screen = 'form';
    render();
  } else if (hash.indexOf('edit-') === 0) {
    const id = parseInt(hash.slice(5), 10);
    if (state.form && !state.form.isNew && state.form.id === id) {
      state.screen = 'form';
      render();
    } else {
      loadEditForm(id);
    }
  } else if (hash === 'browse') {
    state.screen = 'browse';
    render();
    if (!state.concepts.length) loadConcepts();
  } else if (hash.indexOf('detail-') === 0) {
    const id = parseInt(hash.slice(7), 10);
    if (state.conceptDetail && state.conceptDetail.concept && state.conceptDetail.concept.id === id) {
      state.screen = 'detail';
      render();
    } else {
      loadConceptDetail(id);
    }
  } else if (hash === 'success') {
    if (state.lastCreated) { state.screen = 'success'; render(); }
    else { history.back(); } // stale success state (already reset) - just keep going back
  } else if (hash === 'spec-admin') {
    if (!state.specAdmin) state.specAdmin = { retailer: RETAILERS[0], department: DEPARTMENTS[0] };
    state.screen = 'specAdmin';
    render();
  } else if (hash === 'size-admin') {
    state.screen = 'sizeAdmin';
    render();
  } else {
    state.screen = 'home';
    render();
  }
}

window.addEventListener('popstate', () => {
  applyScreenFromHash(location.hash.replace(/^#/, ''));
});

function goHome(){
  history.back();
}

function openCreateConcept(){
  state.form = blankFormState(true);
  pushScreen('create');
  state.screen = 'form';
  render();
}

function goToBrowse(){
  pushScreen('browse');
  state.screen = 'browse';
  render();
  if (!state.concepts.length) loadConcepts();
}

// ---- Browse ----

async function loadConcepts(){
  state.conceptsLoading = true;
  state.conceptsError = '';
  render();
  try {
    const res = await fetch('/api/concepts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load concepts');
    state.concepts = data.concepts;
  } catch (e) {
    state.conceptsError = e.message || 'Could not reach the server';
  }
  state.conceptsLoading = false;
  render();
}

function selectBrowseFilter(d){
  state.browseFilter = d;
  render();
}

// Tapping a concept in Browse goes straight into the full editable form for
// anyone who can actually edit (no extra "Edit Concept" tap first) - buyers
// can't edit at all (blocked server-side, same as desktop), so they still
// land on the read-only Detail view instead.
function openConceptFromBrowse(id){
  if (state.user.role !== 'buyer') openEditConcept(id);
  else openConceptDetail(id);
}

function openConceptDetail(id){
  pushScreen('detail-' + id);
  loadConceptDetail(id);
}

async function loadConceptDetail(id){
  state.screen = 'detail';
  state.conceptDetail = null;
  state.conceptDetailLoading = true;
  state.conceptDetailError = '';
  render();
  try {
    const res = await fetch('/api/concepts/' + id);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load this concept');
    state.conceptDetail = data;
  } catch (e) {
    state.conceptDetailError = e.message || 'Could not reach the server';
  }
  state.conceptDetailLoading = false;
  render();
}

function closeDetail(){
  history.back();
}

function openLightbox(url){
  state.lightboxUrl = url;
  render();
}

function closeLightbox(){
  state.lightboxUrl = null;
  render();
}

// Shares the concept's first 2 reference photos (excludes the generated
// CAD - a separate, already-composited front+back image) straight to
// WhatsApp with the concept code as the message text, via the Web Share
// API - phones support attaching real files this way, which is the only
// way to get actual photos into WhatsApp (wa.me links only support
// prefilled text, never media). Falls back to downloading the photos and
// opening a WhatsApp Web chat prefilled with the code, for the rare mobile
// browser that doesn't support file sharing. Lives on state.form (the full
// edit form) rather than state.conceptDetail, since tapping a concept in
// Browse goes straight into the edit form for anyone who isn't a buyer -
// see openConceptFromBrowse - so that's the view that actually needs it.
async function shareConceptWhatsApp(){
  const f = state.form;
  if (!f) return;
  const refPhotos = (f.photos||[]).filter(p => p.role !== 'cad' && p.role !== 'cad_detail').slice(0, 2);
  if (!refPhotos.length) return;

  let files = [];
  try {
    files = await Promise.all(refPhotos.map(async (p, i) => {
      const res = await fetch(p.path);
      const blob = await res.blob();
      const ext = (p.path.split('.').pop() || 'jpg').split('?')[0];
      return new File([blob], `${f.concept_no}-${i+1}.${ext}`, { type: blob.type || 'image/jpeg' });
    }));
  } catch(e) {
    f.error = 'Could not load photos: ' + e.message;
    render();
    return;
  }

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, text: f.concept_no });
    } catch(e) {
      if (e.name !== 'AbortError') { f.error = 'Could not share: ' + e.message; render(); }
    }
    return;
  }

  refPhotos.forEach((p, i) => {
    const a = document.createElement('a');
    a.href = p.path;
    a.download = `${f.concept_no}-${i+1}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  window.open(`https://wa.me/?text=${encodeURIComponent(f.concept_no)}`, '_blank');
}

// ---- Edit an existing concept ----

function openEditConcept(id){
  pushScreen('edit-' + id);
  loadEditForm(id);
}

async function loadEditForm(id){
  state.screen = 'form';
  state.form = null;
  render();
  try {
    const res = await fetch('/api/concepts/' + id);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load this concept');
    const c = data.concept;
    const concept = blankFormConcept();
    Object.keys(concept).forEach(k => { if (c[k] != null) concept[k] = c[k]; });
    state.form = {
      isNew: false, id: c.id, concept_no: c.concept_no, concept, specCategoryId: c.spec_category_id || null,
      photos: data.photos || [], pendingFiles: [], tab: 'details', submitting: false, error: '', validationHint: '',
      cadBusy: false, cadPreview: null, conversions: data.conversions || [],
    };
    render();
  } catch (e) {
    state.form = { loadError: e.message || 'Could not reach the server' };
    render();
  }
}

function resetForm(targetScreen){
  state.lastCreated = null;
  if (targetScreen === 'home') {
    state.form = null;
    pushScreen('home');
    state.screen = 'home';
  } else {
    state.form = blankFormState(true);
    pushScreen('create');
    state.screen = 'form';
  }
  render();
}

// ---- Camera/gallery/CAD-file pickers ----

function openCamera(){
  const input = document.getElementById('cameraInput');
  input.value = '';
  input.click();
}

function openGallery(){
  const input = document.getElementById('galleryInput');
  input.value = '';
  input.click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cameraInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file || !state.form) return;
    if (state.form.isNew) {
      state.form.pendingFiles.push({ file, previewUrl: URL.createObjectURL(file) });
      state.form.validationHint = '';
      render();
    } else {
      uploadFormPhotos([file]);
    }
  });

  document.getElementById('galleryInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !state.form) return;
    if (state.form.isNew) {
      files.forEach(file => state.form.pendingFiles.push({ file, previewUrl: URL.createObjectURL(file) }));
      state.form.validationHint = '';
      render();
    } else {
      uploadFormPhotos(files);
    }
  });

  document.getElementById('cadFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file && state.form && !state.form.isNew) uploadFormCadMain(file);
  });
});

// ---- Install prompt ----

async function triggerInstall(){
  if (!state.installPromptEvent) return;
  state.installPromptEvent.prompt();
  const choice = await state.installPromptEvent.userChoice;
  // A captured prompt event can only be used once, win or lose.
  state.installPromptEvent = null;
  if (choice.outcome === 'accepted') state.installBannerDismissed = true;
  render();
}

function dismissInstallBanner(){
  state.installBannerDismissed = true;
  render();
}

// Chrome/Android fires this once the page meets PWA install criteria
// (manifest + service worker + icons, all already in place). Calling
// preventDefault() suppresses the browser's own mini-infobar so the
// install-banner button can trigger the same native prompt on tap instead.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPromptEvent = e;
  render();
});

window.addEventListener('appinstalled', () => {
  state.installPromptEvent = null;
  state.installBannerDismissed = true;
  render();
});

// ---- Boot ----
render();
checkSession();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/mobile/sw.js').catch(() => {});
  });
}
