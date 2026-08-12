// ---- Style drawer: view/edit a single style across tabs, with Save ----
// Details tab mirrors the Concept drawer's Details tab field-for-field (see
// CONCEPT_TO_STYLE_FIELDS below and renderBriefTab) - season/raw_brief/
// spec_notes/target_cost/the old free-text fabric field are retired
// (concepts never had them; the new field set replaces what they stood in
// for). target_rsp stays, just no longer edited here - see its own comment
// on the Worksheet-adjacent block below.
function blankStyleDraft(){
  return { id:null, style_no:'', retailer:RETAILERS[0], department:'Ladies', buyer:'', description:'',
    stage:'brief',
    fabric_code:'', composition:'', weight:'',
    wash:'', colour:'', print:'', embroidery_applique:'',
    topstitch:'', trims:'', styling:'',
    units:'', size_range_id:'', packing:'', labels:'',
    source:'', tags:'', concept_date:'', factory:'', shipping_date:'', dc_date:'',
    // target_rsp is read-only everywhere now (still shown on the Style
    // Pipeline board card) but no UI sets it. cost_estimate through
    // factory_price are the Cost tab - field-for-field the same as the
    // Concept drawer's own Costs tab, see CONCEPT_TO_STYLE_FIELDS below.
    target_rsp:'', cost_estimate:'', buyer_rand_target:'', buyer_rsp_target:'',
    factory_target_price:'', factory_price:'', factory_cost_options:'' };
}

// Field-name pairs that differ between concepts.<key> and styles.<key> -
// used by openNewStyle() below to map every concept Details field onto a
// newly converted style. Anything not listed here shares the same key on
// both sides (see db.js's comment on why `topstitching` stayed `topstitch`
// on styles rather than being renamed to match).
const CONCEPT_TO_STYLE_FIELD_RENAMES = { topstitching: 'topstitch' };
const CONCEPT_TO_STYLE_FIELDS = [
  'description', 'cad_description', 'fabric_code', 'composition', 'weight', 'wash', 'colour', 'print', 'embroidery_applique',
  'topstitching', 'trims', 'styling', 'units', 'size_range_id', 'packing', 'labels',
  'source', 'tags', 'concept_date', 'factory', 'shipping_date', 'dc_date',
  'cost_estimate', 'buyer_rand_target', 'buyer_rsp_target', 'factory_target_price', 'factory_price', 'factory_cost_options'
];

async function openStyle(id){
  // requests fetched alongside everything else, same reasoning as
  // openConcept() in concepts.js - the Requests tab's history needs to be
  // ready the moment it's clicked, since tab switches only toggle CSS
  // visibility (see setDrawerTab) rather than re-rendering.
  const [{ style, comments, photos, fabricReports }, requestsRes] = await Promise.all([
    api('/api/styles/'+id),
    api('/api/styles/'+id+'/requests').catch(() => ({ requests: [] })),
  ]);
  state.drawer = { style, comments, photos, fabricReports, requests: requestsRes.requests || [], isNew:false, tab:'details', lightbox:null, floatPhotoIndex:0, spec:null, specPicking:null };
  renderDrawerOnly();
  // Loaded separately from the main GET above rather than folded into it -
  // this can be a lot of rows for a style with a full measurement sheet,
  // no need to pay that cost just opening the Details tab.
  try {
    const spec = await api('/api/styles/'+id+'/spec');
    if (state.drawer && state.drawer.style.id === id) {
      state.drawer.spec = spec;
      renderDrawerOnly();
    }
  } catch (e) { /* Measurements tab handles spec still being null */ }
}

// prefill.fromConcept (the full concept object, passed by
// convertConceptToStyle() in concepts.js) maps every Details field across
// via CONCEPT_TO_STYLE_FIELDS - this is the "map all those fields during
// conversion" step. A plain prefill.description (used by nothing today, kept
// for callers that don't have a full concept to hand) still works standalone.
function openNewStyle(prefill){
  const style = blankStyleDraft();
  let fromConceptId = null;
  let fromConceptNo = null;
  let fromConceptSpecCategoryId = null;
  if (prefill) {
    if (prefill.department) style.department = prefill.department;
    fromConceptId = prefill.conceptId || null;
    fromConceptNo = prefill.conceptNo || null;
    if (prefill.fromConcept) {
      const c = prefill.fromConcept;
      CONCEPT_TO_STYLE_FIELDS.forEach(key => {
        const styleKey = CONCEPT_TO_STYLE_FIELD_RENAMES[key] || key;
        style[styleKey] = c[key] || '';
      });
      // Not a Details field (deliberately - see renderBriefTab's comment on
      // why Spec isn't duplicated there), just carried through so saveStyle()
      // can seed the new style's Measurements tab from the same category the
      // concept already had, via the real select-category endpoint (copies
      // the POM bank) rather than a raw field copy that would leave the
      // category "selected" with an empty measurement sheet.
      fromConceptSpecCategoryId = c.spec_category_id || null;
    } else if (prefill.description) {
      style.description = prefill.description;
    }
  }
  state.drawer = { style, comments: [], photos: [], fabricReports: [], isNew:true, tab:'details', lightbox:null, floatPhotoIndex:0, spec:null, specPicking:null, fromConceptId, fromConceptNo, fromConceptSpecCategoryId };
  renderDrawerOnly();
}

function closeDrawer(){ state.drawer = null; render(); }

// Drawer is an overlay independent of the current view (board/users stay
// mounted underneath), so re-render just the drawer + overlay, not the
// whole page - keeps the board/users list state untouched while it's open.
function renderDrawerOnly(){
  const host = document.getElementById('drawer-host');
  if (host) host.outerHTML = renderDrawerHost();
}

function renderDrawerHost(){
  const open = !!state.drawer;
  const lightboxPath = state.drawer && state.drawer.lightbox;
  return `
    <div id="drawer-host">
      <div class="overlay ${open?'open':''}" onclick="closeDrawer()"></div>
      ${open ? renderFloatingMainPhoto() : ''}
      <div class="drawer ${open?'open':''}">
        ${open ? renderDrawerContent() : ''}
      </div>
      ${lightboxPath ? renderLightbox(lightboxPath) : ''}
      <div id="toast" class="toast"></div>
    </div>`;
}

function renderLightbox(path){
  return `
    <div class="lightbox" onclick="closeLightbox()">
      <img src="${path}" onclick="event.stopPropagation()"/>
      <button class="lightbox-close" onclick="closeLightbox()">&times;</button>
    </div>`;
}
function openLightbox(path){ state.drawer.lightbox = path; renderDrawerOnly(); }
function closeLightbox(){ if (state.drawer) state.drawer.lightbox = null; renderDrawerOnly(); }

// Floats a photo just left of the drawer panel, so it stays in view no
// matter which tab is open on the right - positioned absolute rather than
// as part of the drawer's own layout, per feedback that the two-column-
// inside-the-drawer approach didn't work out. Arrows cycle through all of
// the style's photos, not just the first-uploaded one.
function renderFloatingMainPhoto(){
  const { photos, isNew } = state.drawer;
  if (isNew) return '';
  const list = photos || [];
  if (!list.length) return '';
  const idx = Math.min(state.drawer.floatPhotoIndex || 0, list.length - 1);
  state.drawer.floatPhotoIndex = idx;
  const current = list[idx];
  const hasMultiple = list.length > 1;
  return `
    <div class="drawer-float-photo">
      ${hasMultiple ? `<button class="float-photo-nav prev" onclick="event.stopPropagation(); shiftFloatPhoto(-1)">&#8249;</button>` : ''}
      <img src="${current.path}" onclick="openLightbox('${current.path}')"/>
      ${hasMultiple ? `<button class="float-photo-nav next" onclick="event.stopPropagation(); shiftFloatPhoto(1)">&#8250;</button>` : ''}
      ${hasMultiple ? `<div class="float-photo-count">${idx+1} / ${list.length}</div>` : ''}
    </div>`;
}

// Patches just the floating photo element rather than the whole drawer host
// - same reasoning as setDrawerTab: a full re-render would rebuild every
// input from state.drawer.style and wipe out anything typed but unsaved.
function shiftFloatPhoto(delta){
  const list = state.drawer.photos || [];
  if (!list.length) return;
  const cur = state.drawer.floatPhotoIndex || 0;
  state.drawer.floatPhotoIndex = (cur + delta + list.length) % list.length;
  const el = document.querySelector('.drawer-float-photo');
  if (el) el.outerHTML = renderFloatingMainPhoto();
}

function toast(msg){
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2200);
}

function renderDrawerContent(){
  const { style: s, comments, photos, fabricReports, isNew, tab } = state.drawer;
  const canEdit = state.user.role !== 'buyer';
  const hasCad = !isNew && (photos||[]).some(p=>p.role==='cad');
  const hasWashcare = !isNew && (photos||[]).some(p=>p.role==='washcare');
  const tabs = [['details','Details'],
    ...(canEdit ? [['costing','Cost']] : []),
    ...(!isNew && canEdit ? [['requests','Requests']] : []),
    ...(!isNew ? [['cad', 'CAD'+(hasCad?' ✓':'')], ['washcare', 'Wash Care'+(hasWashcare?' ✓':'')], ['fabric', 'Fabric Report'+((fabricReports&&fabricReports.length)?` (${fabricReports.length})`:'')], ['measurements','Measurements']] : []),
    ['doc','Discussion Doc'],['comments','Comments']];
  return `
    <div class="drawer-head">
      <h2>${isNew ? 'New Style' : s.style_no}</h2>
      <button class="drawer-close" onclick="closeDrawer()">&times;</button>
    </div>
    ${isNew ? '' : renderPhotoSection(s, photos, canEdit)}
    <div class="tabs">
      ${tabs.map(([id,label])=>`<button class="tab ${tab===id?'active':''}" data-tab="${id}" onclick="setDrawerTab('${id}')">${label}</button>`).join('')}
    </div>
    <div class="drawer-body">
      ${renderBriefTab(s, isNew, canEdit)}
      ${renderStyleCostsTab(s, canEdit)}
      ${!isNew && canEdit ? renderStyleRequestsTab() : ''}
      ${isNew ? '' : renderStyleCadTab(s, photos, canEdit)}
      ${isNew ? '' : renderWashcareTab(s, photos, canEdit)}
      ${isNew ? '' : renderFabricReportTab(s, fabricReports, canEdit)}
      ${isNew ? '' : renderMeasurementsTab(s, canEdit)}
      ${renderDocTab(s)}
      ${renderCommentsTab(s, comments)}
    </div>
<footer class="drawer-actions">
      ${canEdit && !isNew ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteStyle(${s.id}, '${s.style_no}')">Delete</button>` : ''}
      ${canEdit && !isNew ? `<button class="btn btn-ghost" onclick="openDuplicateStyleModal(${s.id}, '${s.style_no}')">Duplicate</button>` : ''}
      ${canEdit ? `<button class="btn btn-primary" onclick="saveStyle()">${isNew ? 'Create style' : 'Save changes'}</button>` : ''}
    </footer>`;
}

function renderPhotoSection(s, photos, canEdit){
  const grid = (photos && photos.length) ? `
    <div class="photo-grid">
      ${photos.map(p=>`
        <div class="photo-thumb-wrap">
          <img class="photo-thumb" src="${p.path}" onclick="openLightbox('${p.path}')"/>
          ${canEdit ? `<button class="photo-remove" onclick="event.stopPropagation(); removePhoto(${s.id}, ${p.id})">&times;</button>` : ''}
        </div>
      `).join('')}
    </div>` : `<div class="drawer-photo-placeholder">No photos yet</div>`;
  return `
    <div class="photo-section">
      ${grid}
      ${canEdit ? `
        <input type="file" id="photo-input" accept="image/*" multiple style="display:none;" onchange="uploadPhotos(${s.id})"/>
        <div class="row-actions" style="margin-top:8px;">
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('photo-input').click()">+ Add photos</button>
        </div>
      ` : ''}
    </div>`;
}

function updateCoverInBoardList(styleId, photos){
  const idx = state.styles.findIndex(x=>x.id===styleId);
  if (idx>=0) state.styles[idx] = { ...state.styles[idx], cover_photo: photos.length ? photos[0].path : null };
}

async function uploadPhotos(styleId){
  const input = document.getElementById('photo-input');
  const files = input.files;
  if (!files || !files.length) return;
  const formData = new FormData();
  for (let i=0; i<files.length; i++) formData.append('photos', files[i]);
  try {
    const res = await fetch('/api/styles/'+styleId+'/photos', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.drawer.photos = data.photos;
    updateCoverInBoardList(styleId, data.photos);
    renderDrawerOnly();
    toast(`${files.length} photo${files.length===1?'':'s'} added`);
  } catch(e) {
    toast(e.message);
  }
}

async function removePhoto(styleId, photoId){
  if (!confirm('Remove this photo?')) return;
  try {
    const { photos } = await api('/api/styles/'+styleId+'/photos/'+photoId, { method:'DELETE' });
    state.drawer.photos = photos;
    updateCoverInBoardList(styleId, photos);
    renderDrawerOnly();
    toast('Photo removed');
  } catch(e) { toast(e.message); }
}

// Switches tabs by toggling CSS classes on the already-rendered panels
// instead of re-rendering the drawer - every panel's inputs are already in
// the DOM at once (see renderDrawerContent), just hidden via .active. A full
// re-render here would rebuild every input from state.drawer.style, which is
// only updated at Save time - wiping out anything typed but not yet saved.
function setDrawerTab(id){
  state.drawer.tab = id;
  document.querySelectorAll('.drawer .tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === id);
  });
  document.querySelectorAll('.drawer .drawer-body > [data-tab]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tab === id);
  });
}
function tabClass(id){ return 'tab-panel ' + (state.drawer.tab===id ? 'active' : ''); }

function fld(label, id, val, disabled, type){
  type = type || 'text';
  return `<div class="field"><label>${label}</label><input id="${id}" value="${val!=null?val:''}" ${disabled?'disabled':''} type="${type}"/></div>`;
}
function taFld(label, id, val, disabled){
  return `<div class="field"><label>${label}</label><textarea id="${id}" ${disabled?'disabled':''}>${val!=null?val:''}</textarea></div>`;
}

// Field-for-field the same as the Concept drawer's Details tab
// (public/js/concepts.js's renderConceptDrawerBody) - the only additions
// are the 3 style-specific ones: Converted from concept, Style number, and
// Buyer. Spec is deliberately NOT duplicated here even though concepts have
// it - a style's spec category lives on its own Measurements tab instead,
// which (unlike a plain field) copies the bank's POMs on selection; showing
// the raw picker here too would give two ways to set the same column, one
// of them silently skipping that copy.
// Full "Ladies > Denim > Short" breadcrumb for a leaf spec_categories id -
// walks the parent_id chain via the already-loaded state.specCategories.
// Only used for the New Style "will carry this spec over" confirmation
// below; the Measurements tab itself just shows the leaf name.
// Twin of renderConceptFactorySelect in concepts.js - same
// state.factoryNames list (Contacts' Factory-position company names, see
// loadStyles()' fetch), so a style and a concept pick from the identical set
// rather than each drifting into their own free-text spellings. A style's
// already-saved factory name that isn't (or isn't yet) in Contacts is still
// shown as a selectable option, same reasoning as the concept version.
function renderStyleFactorySelect(current){
  const names = state.factoryNames || [];
  const known = names.includes(current);
  const opts = [`<option value="">— Select factory —</option>`];
  if (current && !known) opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not in Contacts)</option>`);
  names.forEach(n => opts.push(`<option value="${escapeHtml(n)}" ${n===current?'selected':''}>${escapeHtml(n)}</option>`));
  return `<select id="f-factory">${opts.join('')}</select>`;
}

function specCategoryPath(id){
  const byId = {};
  (state.specCategories||[]).forEach(n => { byId[n.id] = n; });
  const names = [];
  let cur = byId[id];
  while (cur) { names.unshift(cur.name); cur = cur.parent_id ? byId[cur.parent_id] : null; }
  return names.join(' > ');
}

function renderBriefTab(s, isNew, canEdit){
  const deptOptions = DEPARTMENTS.map(d=>`<option value="${d}" ${s.department===d?'selected':''}>${d}</option>`).join('');
  const retailerOptions = RETAILERS.map(r=>`<option value="${r}" ${s.retailer===r?'selected':''}>${r}</option>`).join('');
  return `<div class="${tabClass('details')}" data-tab="details">
    ${(!isNew && s.concept_ref) ? `<div class="field"><label>Converted from concept</label><input value="${s.concept_ref}" disabled/></div>` : ''}
    ${(isNew && state.drawer.fromConceptSpecCategoryId) ? `<div class="hint" style="margin-bottom:10px;">This concept's spec category (${specCategoryPath(state.drawer.fromConceptSpecCategoryId)}) will be applied to the new style's Measurements tab once created.</div>` : ''}
    ${isNew ? `
      <div class="row2">
        <div class="field"><label>Retailer</label><select id="f-retailer" onchange="onStyleRetailerOrDeptChange()">${retailerOptions}</select></div>
        <div class="field"><label>Department</label><select id="f-department" onchange="onStyleRetailerOrDeptChange()">${deptOptions}</select></div>
      </div>
      <div class="field"><label>Style number (leave blank to auto-generate)</label><input id="f-style-no" placeholder="auto"/></div>
    ` : `
      <div class="field"><label>Style number</label><input id="f-style_no" value="${s.style_no||''}" ${canEdit?'':'disabled'}/></div>
      <div class="field"><label>Department</label><input id="f-department-display" value="${s.department||''}" disabled/></div>
      <div class="field"><label>Pipeline stage</label>
        <select id="f-stage" ${canEdit?'':'disabled'}>
          ${STAGES.map(st=>`<option value="${st.id}" ${st.id===s.stage?'selected':''}>${st.label}</option>`).join('')}
        </select>
      </div>
    `}
    ${taFld('Description', 'f-description', s.description, !canEdit)}
    ${renderBuyerField(s, isNew, canEdit)}
    <div class="field">
      <label>Fabric</label>
      <select id="f-fabric_code" onchange="onStyleFabricPicked(this.value)" ${canEdit?'':'disabled'}>
        <option value="" ${!s.fabric_code?'selected':''}>-</option>
        ${(state.fabrics||[]).map(f=>`<option value="${f.code}" ${s.fabric_code===f.code?'selected':''}>${f.code}</option>`).join('')}
      </select>
    </div>
    <div class="row2">
      ${fld('Composition', 'f-composition', s.composition, !canEdit)}
      ${fld('Weight (oz)', 'f-weight', s.weight, !canEdit)}
    </div>
    ${taFld('Wash', 'f-wash', s.wash, !canEdit)}
    ${taFld('Colour', 'f-colour', s.colour, !canEdit)}
    <div class="field"><label>Print</label><textarea id="f-print" ${canEdit?'':'disabled'} oninput="updateStyleFabricReportRequirement()">${s.print||''}</textarea></div>
    <div class="field"><label>Embroidery / Applique</label><textarea id="f-embroidery_applique" ${canEdit?'':'disabled'} oninput="updateStyleFabricReportRequirement()">${s.embroidery_applique||''}</textarea></div>
    <div id="f-fabric-report-requirement" class="field">${renderStyleFabricReportRequirement(styleNeedsPrintReport(s))}</div>
    ${taFld('Topstitching', 'f-topstitch', s.topstitch, !canEdit)}
    ${taFld('Trims', 'f-trims', s.trims, !canEdit)}
    ${taFld('Styling', 'f-styling', s.styling, !canEdit)}
    ${fld('Units', 'f-units', s.units, !canEdit)}
    <div class="field">
      <label>Sizes</label>
      <select id="f-size_range_id" ${canEdit?'':'disabled'}>
        <option value="">-</option>
        ${(state.sizeRanges||[]).map(r=>`<option value="${r.id}" ${String(s.size_range_id)===String(r.id)?'selected':''}>${r.values.join(' / ')}</option>`).join('')}
      </select>
      <div class="hint" style="margin-top:4px;"><a href="javascript:void(0)" onclick="openSizeManager()">manage size ranges</a></div>
    </div>
    ${taFld('Packing', 'f-packing', s.packing, !canEdit)}
    ${taFld('Labels', 'f-labels', s.labels, !canEdit)}
    <div class="field"><label>Source</label>
      <select id="f-source" ${canEdit?'':'disabled'}>
        <option value="" ${!s.source?'selected':''}>-</option>
        <option value="Buyer photo" ${s.source==='Buyer photo'?'selected':''}>Buyer photo</option>
        <option value="In-house sample" ${s.source==='In-house sample'?'selected':''}>In-house sample</option>
        <option value="Bought-in reference" ${s.source==='Bought-in reference'?'selected':''}>Bought-in reference</option>
      </select>
    </div>
    <div class="field"><label>Tags (comma separated)</label><input id="f-tags" value="${s.tags||''}" ${canEdit?'':'disabled'}/></div>
    <div class="field"><label>Concept date</label><input type="month" id="f-concept_date" value="${s.concept_date||''}" ${canEdit?'':'disabled'}/></div>
    ${canEdit ? `
      <div class="field"><label>Factory</label>${renderStyleFactorySelect(s.factory)}</div>
      <div class="row2">
        <div class="field"><label>Shipping Date</label><input type="date" id="f-shipping_date" value="${s.shipping_date||''}"/></div>
        <div class="field"><label>DC Date</label><input type="date" id="f-dc_date" value="${s.dc_date||''}"/></div>
      </div>
    ` : ''}
  </div>`;
}

// Live lookup against the already-loaded fabrics list, same pattern as
// onConceptFabricPicked() in concepts.js - unconditionally overwrites
// composition/weight on pick, but both stay freely editable afterward.
function onStyleFabricPicked(code){
  const s = state.drawer.style;
  s.fabric_code = code;
  const fab = (state.fabrics||[]).find(f=>f.code===code);
  if (fab) {
    s.composition = fab.composition || '';
    s.weight = fab.weight || '';
  }
  renderDrawerOnly();
}

// Same reasoning as concepts.js's conceptNeedsPrintReport/
// renderFabricReportRequirement - a style with Print or Embroidery/Applique
// details needs an additional Print/Embellishment fabric report on top of
// the base one (see routes/fabrics.js's fabric_test_reports.report_type).
function styleNeedsPrintReport(s){
  return !!((s.print && s.print.trim()) || (s.embroidery_applique && s.embroidery_applique.trim()));
}
function renderStyleFabricReportRequirement(needsReport){
  return needsReport
    ? `<div class="hint" style="color:var(--stitch-red);font-weight:700;">⚠ Print or Embroidery/Applique has details - an additional Print/Embellishment fabric report is required, on top of the base fabric report.</div>`
    : `<div class="hint">No print or embroidery/applique details entered - the base fabric report is sufficient.</div>`;
}
// Called via oninput on Print/Embroidery-Applique - reads straight from the
// DOM (both fields already exist there) and patches only this one div, same
// reasoning as concepts.js's updateFabricReportRequirement: no full
// render(), so nothing typed elsewhere in the drawer is ever at risk.
function updateStyleFabricReportRequirement(){
  const s = { print: document.getElementById('f-print').value, embroidery_applique: document.getElementById('f-embroidery_applique').value };
  const el = document.getElementById('f-fabric-report-requirement');
  if (el) el.innerHTML = renderStyleFabricReportRequirement(styleNeedsPrintReport(s));
}

// ---- Buyer auto-fill from Contacts (New Style only) - looks up Buyer-
// position contacts for the chosen retailer+department and either fills the
// free-text field (0 or 1 match) or offers a dropdown to choose (2+ matches).
// Only the buyer-field-wrap subtree is patched on retailer/department change,
// not a full drawer re-render, so it doesn't steal focus mid-selection.
function matchingBuyerContacts(retailer, department){
  return (state.contacts || []).filter(c => c.position === 'Buyer' && c.retailer === retailer && c.department === department);
}

function renderBuyerField(s, isNew, canEdit){
  if (!isNew) return fld('Buyer', 'f-buyer', s.buyer, !canEdit);
  return `<div class="field" id="buyer-field-wrap">${buyerFieldInnerHtml(s.retailer, s.department)}</div>`;
}

function buyerFieldInnerHtml(retailer, department){
  const matches = matchingBuyerContacts(retailer, department);
  let control, resultHtml = '';
  if (matches.length === 0) {
    control = `<input id="f-buyer" placeholder="No buyer on file - type a name"/>`;
  } else if (matches.length === 1) {
    const b = matches[0];
    control = `<input id="f-buyer" value="${b.first_name} ${b.last_name}"/>`;
    resultHtml = `<div class="buyer-result found">Auto-filled from Contacts.<div class="buyer-detail">${b.email||''}${b.phone?(' · '+b.phone):''}</div></div>`;
  } else {
    const opts = matches.map(b=>`<option value="${b.first_name} ${b.last_name}">${b.first_name} ${b.last_name}</option>`).join('');
    control = `<select id="f-buyer" onchange="onStyleBuyerPicked()">${opts}</select>`;
    const first = matches[0];
    resultHtml = `<div class="buyer-result multi" id="buyer-result-detail">${matches.length} buyers on file for ${retailer} / ${department} - pick one.<div class="buyer-detail">${first.email||''}${first.phone?(' · '+first.phone):''}</div></div>`;
  }
  return `<label>Buyer</label>${control}${resultHtml}`;
}

function onStyleRetailerOrDeptChange(){
  const retailer = document.getElementById('f-retailer').value;
  const department = document.getElementById('f-department').value;
  const wrap = document.getElementById('buyer-field-wrap');
  if (wrap) wrap.innerHTML = buyerFieldInnerHtml(retailer, department);
}

function onStyleBuyerPicked(){
  const select = document.getElementById('f-buyer');
  const retailer = document.getElementById('f-retailer').value;
  const department = document.getElementById('f-department').value;
  const b = matchingBuyerContacts(retailer, department).find(c => (c.first_name+' '+c.last_name) === select.value);
  const detail = document.getElementById('buyer-result-detail');
  if (b && detail) detail.innerHTML = `Selected.<div class="buyer-detail">${b.email||''}${b.phone?(' · '+b.phone):''}</div>`;
}

// Field-for-field the same as the Concept drawer's own Costs tab (see
// concepts.js's costsTabHtml) - same field names too, so
// CONCEPT_TO_STYLE_FIELDS can map them straight across on conversion. Hidden
// entirely for buyers (both the tab button in renderDrawerContent and this
// panel), same as Concepts, rather than shown with a "not shared" message
// like the old Worksheet tab did - costing data doesn't belong in a buyer
// session at all. % Margin is never stored, just recomputed live from Buyer
// Rand/RSP Target - see updateStyleMargin below.
function renderStyleCostsTab(s, canEdit){
  if (!canEdit) return '';
  return `<div class="${tabClass('costing')}" data-tab="costing">
    ${fld('Cost estimate (R)', 'f-cost_estimate', s.cost_estimate)}
    <div class="row2">
      <div class="field"><label>Buyer Rand Target</label><input id="f-buyer_rand_target" value="${s.buyer_rand_target||''}" oninput="updateStyleMargin()"/></div>
      <div class="field"><label>Buyer RSP Target</label><input id="f-buyer_rsp_target" value="${s.buyer_rsp_target||''}" oninput="updateStyleMargin()"/></div>
    </div>
    <div class="field">
      <label>% Margin</label>
      <div id="f-style-margin-display" style="font-size:15px;font-weight:700;color:var(--ink);padding:6px 0;">${formatConceptMargin(s.buyer_rand_target, s.buyer_rsp_target)}</div>
      <div class="hint" style="margin-top:2px;">The % margin the buyer makes, from Buyer Rand Target (ex VAT, 15% added for this calc) vs Buyer RSP Target - recalculates as you type, nothing saved separately.</div>
    </div>
    <div class="row2">
      ${fld('Factory Target $ Price', 'f-factory_target_price', s.factory_target_price)}
      ${fld('Factory $ Price', 'f-factory_price', s.factory_price)}
    </div>
    ${taFld('Factory Cost Options', 'f-factory_cost_options', s.factory_cost_options)}
    <div class="hint" style="margin-top:-6px;">Cheaper alternatives the factory offered against the target price, e.g. "$7.00 without back pockets" or "$6.80 with an enzyme wash instead of acid wash and no turn-up hem".</div>
  </div>`;
}
function updateStyleMargin(){
  const rand = document.getElementById('f-buyer_rand_target').value;
  const rsp = document.getElementById('f-buyer_rsp_target').value;
  const el = document.getElementById('f-style-margin-display');
  if (el) el.textContent = formatConceptMargin(rand, rsp);
}

// ---- Style drawer's Requests tab - twin of concepts.js's request composer/
// history, minus the Cost type (costing negotiation happens at the Concept
// stage, before a style even exists - see routes/styles.js's send-request
// route for the enforced type list). Backed by the same concept_requests
// table concepts use, just keyed by style_id instead of concept_id.
const STYLE_REQUEST_TYPES = ['sample', 'pp_sample', 'bulk_sample', 'fabric_test'];

function renderStyleRequestComposer(){
  const d = state.drawer;
  const composer = d.composer;
  if (!composer) return '';
  const emailContacts = (composer.contacts || []).filter(c => c.email);
  const contactOpts = emailContacts.map(c =>
    `<option value="${c.email}">${c.first_name} ${c.last_name} - ${c.company || ''}</option>`
  ).join('');
  // Same multi-recipient support as the Concept drawer's own composer (see
  // that one's comment in concepts.js) - "Send to" accepts comma-separated
  // addresses, these buttons just make adding a second saved contact quicker
  // than typing their email by hand.
  const currentEmails = (composer.to || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const addButtons = emailContacts.filter(c => !currentEmails.includes(c.email.toLowerCase())).map(c =>
    `<button type="button" class="btn btn-ghost btn-sm" onclick="addStyleRequestRecipient('${c.email.replace(/'/g,"\\'")}')">+ ${c.first_name} ${c.last_name}</button>`
  ).join('');
  return `
    <div class="field" style="margin-top:14px;background:var(--line-soft);padding:12px;border-radius:var(--radius);">
      <label>${REQUEST_TYPES[composer.type].en}</label>
      <textarea id="style-request-message" placeholder="What do you need from the factory?" style="margin-top:6px;">${escapeHtml(composer.message||'')}</textarea>
      <label style="margin-top:10px;display:block;">Send to</label>
      <input id="style-request-to" value="${composer.to || ''}" placeholder="factory@example.com" list="style-request-to-list" onchange="syncStyleRequestComposerTo(this.value)"/>
      <datalist id="style-request-to-list">${contactOpts}</datalist>
      <div class="hint" style="margin-top:4px;">Separate multiple addresses with a comma to send to more than one recipient.</div>
      ${addButtons ? `<div class="row-actions" style="margin-top:8px;flex-wrap:wrap;">${addButtons}</div>` : ''}
      ${composer.matchName
        ? `<div class="hint" style="margin-top:4px;">Matched saved contact: ${composer.matchName}</div>`
        : `<div class="hint" style="margin-top:4px;">No saved Factory contact matched this style's Factory field (${escapeHtml(d.style.factory || '(not set)')}) - pick a saved contact above or type an email. Add factory contacts under Contacts.</div>`}
      <div class="row-actions" style="margin-top:10px;">
        <button class="btn btn-ghost" onclick="closeStyleRequestComposer()">Cancel</button>
        <button class="btn btn-primary" onclick="sendStyleRequestNow()">Send</button>
      </div>
    </div>`;
}
function syncStyleRequestComposerTo(value){
  if (state.drawer && state.drawer.composer) state.drawer.composer.to = value;
}
function addStyleRequestRecipient(email){
  const d = state.drawer;
  if (!d || !d.composer) return;
  const el = document.getElementById('style-request-to');
  const current = (el ? el.value : d.composer.to) || '';
  const emails = current.split(',').map(s => s.trim()).filter(Boolean);
  if (!emails.some(e => e.toLowerCase() === email.toLowerCase())) emails.push(email);
  d.composer.to = emails.join(', ');
  renderDrawerOnly();
}
async function openStyleRequestComposer(type){
  const d = state.drawer;
  d.composer = { type, to: '', matchName: '', contacts: [], message: '' };
  renderDrawerOnly();
  try {
    const { match, factoryContacts } = await api('/api/styles/' + d.style.id + '/factory-contact');
    d.composer.contacts = factoryContacts || [];
    if (match && match.email) {
      d.composer.to = match.email;
      d.composer.matchName = `${match.first_name} ${match.last_name}${match.company ? ' - ' + match.company : ''}`;
    }
    renderDrawerOnly();
  } catch(e) { /* composer still usable without a prefill */ }
}
function closeStyleRequestComposer(){
  if (state.drawer) state.drawer.composer = null;
  renderDrawerOnly();
}
async function sendStyleRequestNow(){
  const d = state.drawer;
  const composer = d.composer;
  const to = document.getElementById('style-request-to').value.trim();
  if (!to) { toast('Enter a recipient email'); return; }
  const message = document.getElementById('style-request-message').value.trim();
  if (!message) { toast('Enter a message for this request'); return; }
  try {
    toast('Sending ' + REQUEST_TYPES[composer.type].en.toLowerCase() + '...');
    await api('/api/styles/' + d.style.id + '/send-request', { method:'POST', body: JSON.stringify({ request_type: composer.type, to, message }) });
    toast(REQUEST_TYPES[composer.type].en + ' sent to ' + to);
    d.composer = null;
    await loadStyleRequests();
  } catch(e) {
    toast('Could not send: ' + e.message);
  }
}
async function loadStyleRequests(){
  const d = state.drawer;
  if (!d || !d.style || !d.style.id) return;
  try {
    const { requests } = await api('/api/styles/' + d.style.id + '/requests');
    d.requests = requests;
    renderDrawerOnly();
  } catch(e) { /* non-critical - tab just shows nothing until this succeeds */ }
}
function renderStyleRequestsTab(){
  const d = state.drawer;
  const requests = d.requests || [];
  const typeButtons = STYLE_REQUEST_TYPES.map(type =>
    `<button class="btn btn-ghost btn-sm" onclick="openStyleRequestComposer('${type}')">${REQUEST_TYPES[type].en}</button>`
  ).join(' ');

  const rows = requests.map(r => `
    <tr onclick="openRequestDetail(${r.id})" style="cursor:pointer;">
      <td><span class="qr-type-badge">${requestTypeLabel(r.request_type)}</span></td>
      <td>${r.sent_to}</td>
      <td class="mono">${new Date(r.created_at).toLocaleDateString()}</td>
      <td><span class="qr-status-badge qr-status-${r.status === 'received' ? 'received' : 'awaiting'}">${r.status === 'received' ? 'Received' : 'Awaiting'}</span></td>
      <td style="text-align:right;">
        ${r.status !== 'received' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); remindRequest(${r.id})">Remind${r.reminder_count ? ` (${r.reminder_count})` : ''}</button>` : ''}
      </td>
    </tr>
  `).join('') || `<tr><td colspan="5"><div class="empty-state">No requests sent yet for this style.</div></td></tr>`;

  return `<div class="${tabClass('requests')}" data-tab="requests">
    <div class="field"><label>Send a new request</label></div>
    <div class="row-actions" style="flex-wrap:wrap;row-gap:8px;">${typeButtons}</div>
    ${renderStyleRequestComposer()}
    <div class="field" style="margin-top:22px;"><label>Sent so far</label></div>
    <table class="contacts-table">
      <thead><tr><th>Type</th><th>Sent to</th><th>Sent</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---- CAD tab: main AI/uploaded image, description, preview + download -
// same feature set as the Concepts CAD tab (concepts.js), ported so a
// style keeps full CAD control after conversion rather than being stuck
// with whatever image the concept had at the time. ----
function renderStyleCadTab(s, photos, canEdit){
  const cadPhoto = (photos||[]).find(p=>p.role==='cad');
  return `<div class="${tabClass('cad')}" data-tab="cad">
    <div class="field"><label>Main CAD image</label></div>
    ${cadPhoto ? `
      <div class="cad-preview" onclick="openLightbox('${cadPhoto.path}')">
        <img src="${cadPhoto.path}"/>
        ${canEdit ? `<button class="photo-remove" onclick="event.stopPropagation(); deleteStyleCadPhoto(${s.id}, ${cadPhoto.id})">&times;</button>` : ''}
      </div>
    ` : `<div class="drawer-photo-placeholder">No CAD image yet</div>`}
    ${canEdit ? `
      <input type="file" id="style-cad-main-input" accept="image/*" style="display:none;" onchange="uploadStyleCadMain()"/>
      <div class="row-actions" style="margin-top:8px;">
        <button class="btn btn-ghost btn-sm" onclick="generateOrRegenerateStyleCad()">${cadPhoto ? 'Regenerate' : 'Generate'} with AI</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('style-cad-main-input').click()">+ Upload / override</button>
      </div>
      <div class="hint" style="margin-top:6px;">AI generation uses this style's first two photos above as front/back. Runs in the background — this drawer will close and you can keep working.</div>
    ` : ''}

    <div class="field" style="margin-top:20px;">
      <label>CAD description</label>
      <textarea id="f-cad_description" rows="7" ${canEdit?'':'disabled'} placeholder="e.g. Fit: mid/high rise&#10;Leg: straight/wide leg&#10;Pockets: patch pockets front & back&#10;Closure: zip fly with metal button">${s.cad_description||''}</textarea>
    </div>
    ${canEdit && cadPhoto ? `
      <div class="row-actions" style="margin-top:10px;">
        <button class="btn btn-ghost" onclick="previewStyleCadSheet()">Preview CAD sheet</button>
        <button class="btn btn-primary" onclick="downloadStyleCadFile()">Download CAD file</button>
      </div>
      ${state.drawer.cadPreview ? `
        <div style="margin-top:12px;">
          <img src="${state.drawer.cadPreview.dataUrl}" style="width:100%; border:1px solid var(--line); border-radius:6px; display:block;"/>
          <div class="hint" style="margin-top:6px;">This is exactly what "Download CAD file" will produce as a PDF. Edited the description or photos since this was built? Click "Preview CAD sheet" again to refresh it.</div>
        </div>
      ` : ''}
    ` : ''}
  </div>`;
}

// Wash Care tab - a single label image (role='washcare', same one-photo-by-
// role convention as the CAD tab's role='cad' above) plus free-text notes.
// Can be generated from data already on file (see generateStyleWashcareLabel
// and lib/washcareLabelExport.js) or uploaded as a real printed/woven label
// photo - either way it lands in the same photos row, so nothing downstream
// needs to know which one happened.
function renderWashcareTab(s, photos, canEdit){
  const washcarePhoto = (photos||[]).find(p=>p.role==='washcare');
  return `<div class="${tabClass('washcare')}" data-tab="washcare">
    <div class="field"><label>Wash care label</label></div>
    ${washcarePhoto ? `
      <div class="cad-preview" onclick="openLightbox('${washcarePhoto.path}')">
        <img src="${washcarePhoto.path}"/>
        ${canEdit ? `<button class="photo-remove" onclick="event.stopPropagation(); deleteStyleWashcarePhoto(${s.id}, ${washcarePhoto.id})">&times;</button>` : ''}
      </div>
    ` : `<div class="drawer-photo-placeholder">No wash care label uploaded yet</div>`}
    ${canEdit ? `
      <input type="file" id="style-washcare-input" accept="image/*" style="display:none;" onchange="uploadStyleWashcarePhoto()"/>
      <div class="row-actions" style="margin-top:8px;">
        <button class="btn btn-ghost btn-sm" onclick="generateStyleWashcareLabel()">${washcarePhoto ? 'Regenerate' : 'Generate'} label</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('style-washcare-input').click()">${washcarePhoto ? 'Replace' : '+ Upload'} label</button>
      </div>
      <div class="hint" style="margin-top:6px;">Generate builds the label from composition, wash care details, art no, season and the factory's country/importer code below - fill those in first for a complete label.</div>
    ` : ''}

    <div class="field" style="margin-top:20px;">
      <label>Wash care details</label>
      <textarea id="f-washcare_details" rows="7" ${canEdit?'':'disabled'} placeholder="e.g. Machine wash cold, gentle cycle&#10;Do not bleach&#10;Tumble dry low&#10;Iron on low heat, do not iron print">${s.washcare_details||''}</textarea>
    </div>
    <div class="field" style="margin-top:14px;">
      <label>Art. No (from the PO)</label>
      <input id="f-art_no" value="${(s.art_no||'').replace(/"/g,'&quot;')}" ${canEdit?'':'disabled'}/>
    </div>
  </div>`;
}

// ---- Fabric Report tab: every fabric_test_reports row linked to this
// style (see routes/styles.js's POST/DELETE /:id/fabric-reports) - linking
// happens automatically whenever a report is saved with this style's number
// in its (possibly multi-code, e.g. "PG054/PG061") Style No. text, plus a
// manual "link by report number" action as a fallback/override. ----
function renderFabricReportTab(s, fabricReports, canEdit){
  return `<div class="${tabClass('fabric')}" data-tab="fabric">
    ${(fabricReports && fabricReports.length) ? `
      <div class="test-report-list">
        ${fabricReports.map(r => `
          <div class="test-report-row">
            <a href="${r.file_path}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;flex:1;min-width:0;">
              <div class="mono" style="font-weight:600;">${r.report_number || 'Report'} — ${r.fabric_code} ${r.report_type==='print' ? '<span class="hint" style="color:var(--stitch-red);font-weight:700;">· PRINT</span>' : ''}</div>
              <div class="hint" style="margin:2px 0 0;">${[r.report_date, r.report_type==='print' ? 'Print/Embellishment report' : 'Base report', r.weight_oz ? r.weight_oz+' oz' : (r.weight_gsm ? r.weight_gsm+' g/m²' : ''), r.composition].filter(Boolean).join(' · ')}</div>
            </a>
            ${canEdit ? `
              <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="btn btn-ghost btn-sm" onclick="openEditTestReport(${r.id})">Edit</button>
                <button class="btn btn-ghost btn-sm" onclick="unlinkFabricReport(${s.id}, ${r.id})">Unlink</button>
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    ` : `<div class="hint">No fabric reports linked to this style yet.</div>`}
    ${canEdit ? `
      <div class="field" style="margin-top:18px;">
        <label>Link a fabric report</label>
        <input id="fabric-report-link-input" placeholder="Report number, e.g. NQA260323046"/>
        <div class="hint" style="margin-top:4px;">Reports normally link automatically from their Style No. field when uploaded - use this to link one manually if it didn't, or upload it from Fabrics first if it isn't there yet.</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="linkFabricReport(${s.id})">+ Link report</button>
    ` : ''}
  </div>`;
}

async function linkFabricReport(styleId){
  const input = document.getElementById('fabric-report-link-input');
  const reportNumber = input.value.trim();
  if (!reportNumber) { toast('Enter a report number first'); return; }
  try {
    const { fabricReports } = await api('/api/styles/'+styleId+'/fabric-reports', { method:'POST', body: JSON.stringify({ report_number: reportNumber }) });
    state.drawer.fabricReports = fabricReports;
    renderDrawerOnly();
    toast('Report linked');
  } catch(e) { toast(e.message); }
}

async function unlinkFabricReport(styleId, reportId){
  if (!confirm('Unlink this fabric report from the style?')) return;
  try {
    const { fabricReports } = await api('/api/styles/'+styleId+'/fabric-reports/'+reportId, { method:'DELETE' });
    state.drawer.fabricReports = fabricReports;
    renderDrawerOnly();
    toast('Report unlinked');
  } catch(e) { toast(e.message); }
}

// ---- Measurements tab: a style's own copy of its spec category's POM
// bank (style_spec_poms), with one column per fixed fit stage - filled in
// either by typing values in by hand or uploading the buyer's filled fit
// sheet. See spec_category_poms/style_spec_poms/style_spec_fits in db.js. ----

const SPEC_FIT_STAGE_ORDER = ['1st_fit', '2nd_fit', 'seal_pps'];
const SPEC_FIT_STAGE_LABELS = { '1st_fit': '1st Fit', '2nd_fit': '2nd Fit', 'seal_pps': 'Seal/PPS' };

function renderMeasurementsTab(s, canEdit){
  const spec = state.drawer.spec;
  let body;
  if (!spec) {
    body = `<div class="hint">Loading...</div>`;
  } else if (state.drawer.specPicking || !s.spec_category_id) {
    body = renderStyleSpecPicker(s, canEdit);
  } else {
    body = renderStyleSpecSheet(s, spec, canEdit);
  }
  return `<div class="${tabClass('measurements')}" data-tab="measurements">${body}</div>`;
}

// Same cascading department -> ... -> leaf chain as Concepts' own Spec
// picker (specCategories.js's renderSpecSelector/onSpecLevelChange), just
// targeting state.drawer.specPicking instead of state.conceptDrawer, and
// only committing (useStyleSpecCategory) once a leaf is actually reached -
// picking through the chain here has a real backend side effect (copying
// the bank onto the style), unlike Concepts where it's just saved with the
// rest of the concept on its own Save button. Unlike Concepts though, a
// style always has a real retailer (styles.retailer, required), so this one
// does filter by it - defaults to the style's own retailer/department but,
// same as those, is browsable to a different one while picking.
function renderStyleSpecPicker(s, canEdit){
  if (!canEdit) return `<div class="hint">No spec category set for this style yet.</div>`;
  const picking = state.drawer.specPicking || { retailer: s.retailer, department: s.department, chain: [] };
  const nodes = (state.specCategories||[]).filter(n => n.department === picking.department && n.retailer === picking.retailer);
  const selects = [];
  let parentId = null, level = 0;
  while (true) {
    const options = nodes.filter(n=>n.parent_id===parentId).sort((a,b)=>(a.sort_order-b.sort_order)||a.name.localeCompare(b.name));
    if (!options.length) break;
    const chosen = picking.chain[level] || '';
    selects.push(`<select onchange="onStyleSpecPickLevel(${level}, this.value)">
      <option value="">Select...</option>
      ${options.map(o=>`<option value="${o.id}" ${String(chosen)===String(o.id)?'selected':''}>${o.name}</option>`).join('')}
    </select>`);
    if (!chosen) break;
    parentId = Number(chosen); level++;
  }
  const leafId = picking.chain.length ? picking.chain[picking.chain.length-1] : null;
  const isLeaf = leafId && !nodes.some(n=>n.parent_id===Number(leafId));
  return `
    <div class="hint">${s.spec_category_id ? "Picking a different category replaces this style's measurement sheet and clears any fits already recorded." : "Pick this style's spec category to load its measurement bank."}</div>
    <div class="row2" style="margin-top:10px;">
      <div class="field">
        <label>Retailer</label>
        <select onchange="onStyleSpecRetailerChange(this.value)">
          ${RETAILERS.map(r=>`<option value="${r}" ${picking.retailer===r?'selected':''}>${r}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Department</label>
        <select onchange="onStyleSpecDeptChange(this.value)">
          ${DEPARTMENTS.map(d=>`<option value="${d}" ${picking.department===d?'selected':''}>${d}</option>`).join('')}
        </select>
      </div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">${selects.join('')}</div>
    ${!nodes.length ? `<div class="hint" style="margin-top:8px;">No spec categories set up yet for ${picking.retailer} / ${picking.department} - <a href="javascript:void(0)" onclick="openSpecManager()">manage spec hierarchy</a>.</div>` : ''}
    <div class="row-actions" style="margin-top:14px;">
      ${isLeaf ? `<button class="btn btn-primary btn-sm" onclick="useStyleSpecCategory(${leafId})">Use this spec</button>` : ''}
      ${s.spec_category_id ? `<button class="btn btn-ghost btn-sm" onclick="cancelStyleSpecPicking()">Cancel</button>` : ''}
    </div>
  `;
}
function onStyleSpecRetailerChange(retailer){
  const picking = state.drawer.specPicking || { retailer: state.drawer.style.retailer, department: state.drawer.style.department, chain: [] };
  state.drawer.specPicking = { retailer, department: picking.department, chain: [] };
  renderDrawerOnly();
}
function onStyleSpecDeptChange(dept){
  const picking = state.drawer.specPicking || { retailer: state.drawer.style.retailer, department: state.drawer.style.department, chain: [] };
  state.drawer.specPicking = { retailer: picking.retailer, department: dept, chain: [] };
  renderDrawerOnly();
}
function onStyleSpecPickLevel(level, value){
  const picking = state.drawer.specPicking || { retailer: state.drawer.style.retailer, department: state.drawer.style.department, chain: [] };
  picking.chain = picking.chain.slice(0, level);
  if (value) picking.chain.push(Number(value));
  state.drawer.specPicking = picking;
  renderDrawerOnly();
}
function cancelStyleSpecPicking(){
  state.drawer.specPicking = null;
  renderDrawerOnly();
}
function openStyleSpecPicking(){
  state.drawer.specPicking = { retailer: state.drawer.style.retailer, department: state.drawer.style.department, chain: [] };
  renderDrawerOnly();
}

async function useStyleSpecCategory(categoryId){
  const s = state.drawer.style;
  if (s.spec_category_id && s.spec_category_id !== categoryId) {
    if (!confirm("Picking a different spec category replaces this style's measurement sheet and clears any fits already recorded. Continue?")) return;
  }
  try {
    const { spec_category_id, poms, fits } = await api('/api/styles/'+s.id+'/spec/select-category', { method:'POST', body: JSON.stringify({ spec_category_id: categoryId }) });
    s.spec_category_id = spec_category_id;
    state.drawer.spec = { spec_category_id, poms, fits };
    state.drawer.specPicking = null;
    renderDrawerOnly();
    toast('Spec category set');
  } catch(e) { toast(e.message); }
}

function renderStyleSpecSheet(s, spec, canEdit){
  const category = (state.specCategories||[]).find(n=>n.id===spec.spec_category_id);
  const poms = spec.poms || [];
  const rows = poms.map(p => {
    const cells = SPEC_FIT_STAGE_ORDER.map(stage => {
      const fit = spec.fits[stage];
      const val = fit && fit.values ? fit.values[p.id] : undefined;
      return `<td>${(val!=null && val!=='') ? val : '<span class="hint">—</span>'}</td>`;
    }).join('');
    return `<tr><td class="name-cell">${p.name}</td><td>${p.spec_to_be||''}</td>${cells}</tr>`;
  }).join('') || `<tr><td colspan="${2+SPEC_FIT_STAGE_ORDER.length}"><div class="empty-state">No points of measure in this category's bank yet - add them from Manage Spec Hierarchy.</div></td></tr>`;

  return `
    <div class="topbar" style="padding:0;">
      <div><strong>${category ? category.name : 'Spec category'}</strong></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost btn-sm" onclick="downloadStyleAppraisalReport()">Export appraisal report</button>
        ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openStyleSpecPicking()">Change category</button>` : ''}
      </div>
    </div>
    <div class="contacts-wrap" style="margin-top:10px;">
      <table class="contacts-table">
        <thead><tr><th>Point of measure</th><th>Spec to be</th>${SPEC_FIT_STAGE_ORDER.map(st=>`<th>${SPEC_FIT_STAGE_LABELS[st]}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${canEdit ? `
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">
        ${SPEC_FIT_STAGE_ORDER.map(stage => {
          const fit = spec.fits[stage];
          return `
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
              <span class="hint" style="min-width:70px;">${SPEC_FIT_STAGE_LABELS[stage]}${fit && fit.fit_date ? ' · '+fit.fit_date : ''}</span>
              <button class="btn btn-ghost btn-sm" onclick="openManualFitEntry('${stage}')">${fit?'Edit':'Enter'} values</button>
              <button class="btn btn-ghost btn-sm" onclick="openFitSheetUpload('${stage}')">Upload sheet</button>
              ${fit ? `<button class="btn btn-ghost btn-sm" onclick="deleteFitStage('${stage}')">Clear</button>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;
}

// ---- Manual fit entry: every POM listed with a blank/prefilled input,
// saved all at once via PUT /:id/spec/fits/:stage (upsert). ----
// Pre-filled with each POM's spec-to-be (or its already-recorded actual, if
// re-editing a stage) rather than left blank - most fit rounds only change
// a handful of measurements, so this shows what'll actually be saved for
// everything else (see routes/styles.js's PUT /:id/spec/fits/:stage, which
// applies this same "unchanged = spec-to-be" fallback server-side too) and
// lets the merchandiser only touch the ones that moved.
function openManualFitEntry(stage){
  const spec = state.drawer.spec;
  const fit = spec.fits[stage];
  const values = {};
  (spec.poms||[]).forEach(p => {
    const existing = fit && fit.values && fit.values[p.id];
    values[p.id] = (existing != null && existing !== '') ? existing : (p.spec_to_be || '');
  });
  state.manualFitEntry = { styleId: state.drawer.style.id, stage, values, fit_date: (fit && fit.fit_date) || '', busy:false };
  render();
}
function closeManualFitEntry(){ state.manualFitEntry = null; render(); }

function renderManualFitEntryHost(){
  const m = state.manualFitEntry;
  if (!m) return `<div class="overlay" onclick="closeManualFitEntry()"></div><div class="drawer"></div>`;
  const spec = state.drawer && state.drawer.spec;
  const poms = (spec && spec.poms) || [];
  return `
    <div class="overlay open" onclick="closeManualFitEntry()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${SPEC_FIT_STAGE_LABELS[m.stage]} - Enter measurements</h2>
        <button class="drawer-close" onclick="closeManualFitEntry()">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="field"><label>Fit date</label><input id="mfe-fit_date" type="date" value="${m.fit_date||''}"/></div>
        <div class="contacts-wrap" style="margin-top:10px;">
          <table class="contacts-table">
            <thead><tr><th>Point of measure</th><th>Spec to be</th><th>Actual</th></tr></thead>
            <tbody>
              ${poms.map(p => `
                <tr>
                  <td>${p.name}</td>
                  <td>${p.spec_to_be||''}</td>
                  <td><input value="${(m.values[p.id]||'').toString().replace(/"/g,'&quot;')}" oninput="state.manualFitEntry.values[${p.id}]=this.value"/></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <footer class="drawer-actions">
        <button class="btn btn-primary" ${m.busy?'disabled':''} onclick="saveManualFitEntry()">${m.busy?'Saving...':'Save'}</button>
      </footer>
    </div>`;
}

async function saveManualFitEntry(){
  const m = state.manualFitEntry;
  m.fit_date = document.getElementById('mfe-fit_date').value;
  m.busy = true;
  render();
  try {
    const { poms, fits } = await api('/api/styles/'+m.styleId+'/spec/fits/'+m.stage, { method:'PUT', body: JSON.stringify({ fit_date: m.fit_date, values: m.values }) });
    if (state.drawer && state.drawer.style.id === m.styleId) {
      state.drawer.spec.poms = poms;
      state.drawer.spec.fits = fits;
    }
    state.manualFitEntry = null;
    render();
    toast('Fit saved');
  } catch(e) {
    m.busy = false;
    render();
    toast(e.message);
  }
}

async function deleteFitStage(stage){
  if (!confirm(`Clear the ${SPEC_FIT_STAGE_LABELS[stage]} measurements for this style?`)) return;
  const s = state.drawer.style;
  try {
    const { poms, fits } = await api('/api/styles/'+s.id+'/spec/fits/'+stage, { method:'DELETE' });
    state.drawer.spec.poms = poms;
    state.drawer.spec.fits = fits;
    renderDrawerOnly();
    toast('Cleared');
  } catch(e) { toast(e.message); }
}

// ---- Upload fit sheet: two-step flow, same shape as fabric test report
// upload - extract against this style's known POM names, review/correct,
// then save via the same PUT /:id/spec/fits/:stage manual entry uses
// (source:'upload' + file_path passed through for the audit trail). ----
function openFitSheetUpload(stage){
  state.fitSheetUpload = { styleId: state.drawer.style.id, stage, stage_label: SPEC_FIT_STAGE_LABELS[stage], busy:false, error:'', stageReview:'pick', fit_date:'', values:{}, unmatched:[], file_path:null };
  render();
}
function closeFitSheetUpload(){ state.fitSheetUpload = null; render(); }

function renderFitSheetUploadHost(){
  const t = state.fitSheetUpload;
  if (!t) return `<div class="overlay" onclick="closeFitSheetUpload()"></div><div class="drawer"></div>`;
  let body;
  if (t.stageReview === 'pick') {
    body = `
      <div class="field">
        <label>Filled fit sheet (PDF or .xlsx)</label>
        <input type="file" id="fs-file" accept="application/pdf,.xlsx"/>
        <div class="hint" style="margin-top:6px;">Measured values are read automatically and matched to this style's points of measure - you'll get a chance to check and correct everything before it's saved.</div>
      </div>
      ${t.error ? `<div class="error-msg" style="color:var(--stitch-red);font-size:12.5px;margin-top:8px;">${t.error}</div>` : ''}
    `;
  } else {
    const spec = state.drawer && state.drawer.spec;
    const poms = (spec && spec.poms) || [];
    body = `
      <div class="field"><label>Fit date</label><input id="fs-fit_date" type="date" value="${t.fit_date||''}"/></div>
      <div class="contacts-wrap" style="margin-top:10px;">
        <table class="contacts-table">
          <thead><tr><th>Point of measure</th><th>Spec to be</th><th>Actual (from file)</th></tr></thead>
          <tbody>
            ${poms.map(p => `
              <tr>
                <td>${p.name}</td>
                <td>${p.spec_to_be||''}</td>
                <td><input value="${(t.values[p.id]||'').toString().replace(/"/g,'&quot;')}" oninput="state.fitSheetUpload.values[${p.id}]=this.value"/></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${t.unmatched.length ? `<div class="hint" style="margin-top:10px;">Found in the file but not matched to a point of measure: ${t.unmatched.map(u=>`${u.name} = ${u.value}`).join(', ')}</div>` : ''}
      ${t.error ? `<div class="error-msg" style="color:var(--stitch-red);font-size:12.5px;margin-top:8px;">${t.error}</div>` : ''}
    `;
  }
  return `
    <div class="overlay open" onclick="closeFitSheetUpload()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${t.stage_label} - Upload sheet</h2>
        <button class="drawer-close" onclick="closeFitSheetUpload()">&times;</button>
      </div>
      <div class="drawer-body">${body}</div>
      <footer class="drawer-actions">
        ${t.stageReview === 'pick'
          ? `<button class="btn btn-primary" ${t.busy?'disabled':''} onclick="extractFitSheet()">${t.busy?'Reading file...':'Extract values'}</button>`
          : `<button class="btn btn-primary" ${t.busy?'disabled':''} onclick="saveFitSheetReview()">${t.busy?'Saving...':'Save'}</button>`}
      </footer>
    </div>`;
}

async function extractFitSheet(){
  const t = state.fitSheetUpload;
  const fileInput = document.getElementById('fs-file');
  const file = fileInput.files && fileInput.files[0];
  if (!file) { toast('Choose a file first'); return; }
  t.busy = true; t.error = ''; render();
  try {
    const formData = new FormData();
    formData.append('sheet', file);
    const res = await fetch('/api/styles/'+t.styleId+'/spec/fits/'+t.stage+'/extract', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Could not read that file');
    t.file_path = data.file_path;
    t.fit_date = data.fit_date || '';
    t.unmatched = data.unmatched || [];
    // Same "unchanged = spec-to-be" fallback as manual entry - anything the
    // sheet didn't have a match for defaults to the POM's spec-to-be rather
    // than showing blank, so the review table reads as "here's what'll be
    // saved" rather than leaving gaps to guess at.
    t.values = {};
    (state.drawer.spec.poms || []).forEach(p => {
      const matched = data.matched ? data.matched[p.id] : undefined;
      t.values[p.id] = matched != null ? matched : (p.spec_to_be || '');
    });
    t.stageReview = 'review';
    t.busy = false;
    render();
  } catch(e) {
    t.busy = false; t.error = e.message; render();
  }
}

async function saveFitSheetReview(){
  const t = state.fitSheetUpload;
  t.fit_date = document.getElementById('fs-fit_date').value;
  t.busy = true; render();
  try {
    const { poms, fits } = await api('/api/styles/'+t.styleId+'/spec/fits/'+t.stage, { method:'PUT', body: JSON.stringify({ fit_date: t.fit_date, source:'upload', file_path: t.file_path, values: t.values }) });
    if (state.drawer && state.drawer.style.id === t.styleId) {
      state.drawer.spec.poms = poms;
      state.drawer.spec.fits = fits;
    }
    state.fitSheetUpload = null;
    render();
    toast('Fit sheet saved');
  } catch(e) {
    t.busy = false; t.error = e.message; render();
  }
}

function generateOrRegenerateStyleCad(){
  const { style: s, photos } = state.drawer;
  const sourcePhotos = (photos || []).filter(p => p.role !== 'cad' && p.role !== 'washcare');
  if (sourcePhotos.length < 2) { toast('Add at least two photos above first'); return; }
  const photoIds = [sourcePhotos[0].id, sourcePhotos[1].id];
  const styleId = s.id;
  const styleNo = s.style_no;

  closeDrawer();
  toast(`Generating CAD for ${styleNo} in the background — carry on working`);

  api('/api/styles/'+styleId+'/generate-cad-ai', { method:'POST', body: JSON.stringify({ photoIds }) })
    .then(async () => {
      await loadStyles();
      toast(`${styleNo}'s CAD is ready`);
    })
    .catch(e => {
      toast(`CAD generation failed for ${styleNo}: ` + e.message);
    });
}

async function uploadStyleCadMain(){
  const input = document.getElementById('style-cad-main-input');
  if (!input.files || !input.files.length) return;
  const s = state.drawer.style;
  const formData = new FormData();
  formData.append('photo', input.files[0]);
  try {
    const res = await fetch('/api/styles/'+s.id+'/cad-main', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.drawer.photos = data.photos;
    state.drawer.cadPreview = null;
    renderDrawerOnly();
    await loadStyles();
    toast('CAD image uploaded');
  } catch(e) { toast(e.message); }
}

async function deleteStyleCadPhoto(styleId, photoId){
  if (!confirm('Delete the generated CAD image? You can always generate a new one.')) return;
  try {
    const { photos } = await api('/api/styles/'+styleId+'/photos/'+photoId, { method:'DELETE' });
    state.drawer.photos = photos;
    state.drawer.cadPreview = null;
    renderDrawerOnly();
    await loadStyles();
    toast('CAD image deleted');
  } catch(e) { toast(e.message); }
}

async function uploadStyleWashcarePhoto(){
  const input = document.getElementById('style-washcare-input');
  if (!input.files || !input.files.length) return;
  const s = state.drawer.style;
  const formData = new FormData();
  formData.append('photo', input.files[0]);
  try {
    const res = await fetch('/api/styles/'+s.id+'/washcare-photo', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.drawer.photos = data.photos;
    renderDrawerOnly();
    toast('Wash care label uploaded');
  } catch(e) { toast(e.message); }
}

// Builds the label from whatever's already on the style/fabric/factory
// (composition, wash care details, art no, season, factory country +
// importer/vendor code) - see lib/washcareLabelExport.js. Saves as the same
// role='washcare' photo a manual upload would produce, so it's a straight
// swap-in either way.
async function generateStyleWashcareLabel(){
  const s = state.drawer.style;
  try {
    const data = await api('/api/styles/'+s.id+'/generate-washcare-label', { method:'POST' });
    state.drawer.photos = data.photos;
    renderDrawerOnly();
    toast('Wash care label generated');
  } catch(e) { toast('Could not generate: ' + e.message); }
}

async function deleteStyleWashcarePhoto(styleId, photoId){
  if (!confirm('Remove the wash care label image?')) return;
  try {
    const { photos } = await api('/api/styles/'+styleId+'/photos/'+photoId, { method:'DELETE' });
    state.drawer.photos = photos;
    renderDrawerOnly();
    toast('Wash care label removed');
  } catch(e) { toast(e.message); }
}

// Builds the same landscape sheet layout as concepts.js's
// buildCadSheetDataUrl (image left ~80%, logo/code/description sidebar
// right) - reuses its loadImageEl/drawContain/wrapCanvasText helpers,
// already loaded globally from concepts.js.
async function buildStyleCadSheetDataUrl(){
  const s = state.drawer.style;
  const photos = state.drawer.photos || [];
  const cadPhoto = photos.find(p => p.role === 'cad');
  if (!cadPhoto) return null;

  const descEl = document.getElementById('f-cad_description');
  const liveDescription = descEl ? descEl.value : (s.cad_description || '');

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
  } catch(e) { /* logo optional - layout below doesn't depend on it loading */ }

  ctx.fillStyle = '#1c2833';
  ctx.textAlign = 'left';
  ctx.font = 'bold 46px Oswald, sans-serif';
  ctx.fillText(s.style_no, sbX, 70 + logoH + 70);
  ctx.font = '24px "IBM Plex Sans", sans-serif';
  wrapCanvasText(ctx, s.description || '', sbX, 70 + logoH + 112, textMaxWidth, 32);

  return { dataUrl: canvas.toDataURL('image/png'), description: liveDescription };
}

async function previewStyleCadSheet(){
  try {
    const built = await buildStyleCadSheetDataUrl();
    if (!built) { toast('Generate or upload a main CAD image first'); return; }
    state.drawer.cadPreview = built;
    renderDrawerOnly();
  } catch(e) {
    toast('Could not build preview: ' + e.message);
  }
}

async function downloadStyleCadFile(){
  const s = state.drawer.style;
  try {
    const built = state.drawer.cadPreview || await buildStyleCadSheetDataUrl();
    if (!built) { toast('Generate or upload a main CAD image first'); return; }

    toast('Building PDF...');
    const res = await fetch('/api/styles/' + s.id + '/export-cad-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: built.dataUrl })
    });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Export failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${s.style_no}.pdf`; a.click();
    URL.revokeObjectURL(url);
    toast('CAD file downloaded');
  } catch(e) {
    toast('Could not export PDF: ' + e.message);
  }
}

async function downloadStyleAppraisalReport(){
  const s = state.drawer.style;
  try {
    toast('Building appraisal report...');
    const res = await fetch('/api/styles/' + s.id + '/spec/export-appraisal');
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Export failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${s.style_no}-appraisal-report.xlsx`; a.click();
    URL.revokeObjectURL(url);
    toast('Appraisal report downloaded');
  } catch(e) {
    toast('Could not export appraisal report: ' + e.message);
  }
}

function generateDiscussionDoc(s){
  return [
    `STYLE DISCUSSION DOCUMENT`,
    `Style No: ${s.style_no || '(new - not yet saved)'}`,
    ...(s.concept_ref ? [`Concept ref: ${s.concept_ref}`] : []),
    `Retailer: ${s.retailer||''} — ${s.department||''}`,
    `Buyer: ${s.buyer||''}`,
    ``,
    `DESCRIPTION`,
    s.description || '(none)',
    ``,
    `DETAILS`,
    `Fabric: ${s.fabric_code||'-'}    Composition: ${s.composition||'-'}    Weight: ${s.weight||'-'}`,
    `Colour: ${s.colour||'-'}    Wash: ${s.wash||'-'}`,
    `Print: ${s.print||'-'}    Embroidery/Applique: ${s.embroidery_applique||'-'}`,
    `Topstitching: ${s.topstitch||'-'}`,
    `Trims: ${s.trims||'-'}`,
    `Styling: ${s.styling||'-'}`,
    `Units: ${s.units||'-'}`,
    `Packing: ${s.packing||'-'}`,
    `Labels: ${s.labels||'-'}`,
  ].join('\n');
}

function renderDocTab(s){
  return `<div class="${tabClass('doc')}" data-tab="doc">
    <div class="callout">Auto-generated from the fields on the other tabs — for pasting into an email or factory document.</div>
    <div class="doc-preview">${generateDiscussionDoc(s).replace(/</g,'&lt;')}</div>
    <button class="btn btn-ghost" style="margin-top:12px;" onclick="copyDiscussionDoc()">Copy to clipboard</button>
  </div>`;
}

function copyDiscussionDoc(){
  const text = generateDiscussionDoc(state.drawer.style);
  navigator.clipboard.writeText(text).then(()=>toast('Discussion doc copied')).catch(()=>toast('Could not copy - select and copy manually'));
}

function renderCommentsTab(s, comments){
  return `<div class="${tabClass('comments')}" data-tab="comments">
    ${comments.map(c=>`<div class="comment"><div class="who">${c.author_name} <span class="badge ${c.author_role}">${c.author_role}</span></div><div>${c.body}</div><div class="when">${new Date(c.created_at).toLocaleString()}</div></div>`).join('') || '<p style="color:var(--ink-soft);font-size:13px;">No comments yet.</p>'}
    <div class="field" style="margin-top:14px;"><textarea id="new-comment" rows="3" placeholder="Add a comment..."></textarea></div>
    <button class="btn btn-ghost" onclick="postComment()">Post comment</button>
  </div>`;
}

async function postComment(){
  const s = state.drawer.style;
  const body = document.getElementById('new-comment').value.trim();
  if (!body) return;
  const { comments } = await api('/api/styles/'+s.id+'/comments', { method:'POST', body: JSON.stringify({body}) });
  state.drawer.comments = comments;
  renderDrawerOnly();
}

// 'department' is deliberately excluded - shown read-only on Details for an
// existing style (see f-department-display), never sent. Changing a live
// style's department would also need to rename its style_no prefix (the
// concept-conversion equivalent does this - see concepts.js's own comment
// on renaming c.concept_no); not worth that risk for a field editable at
// creation time already. 'target_rsp' also stays out - Details no longer
// edits it (still shown read-only on the board card), and nothing else does
// either.
const EDITABLE_FIELDS = [
  'style_no','buyer','description','units',
  'fabric_code','composition','weight','wash','colour','print','embroidery_applique',
  'topstitch','trims','styling','size_range_id','packing','labels','source','tags','concept_date',
  'factory','shipping_date','dc_date','cad_description','washcare_details','art_no',
  'cost_estimate','buyer_rand_target','buyer_rsp_target','factory_target_price','factory_price','factory_cost_options'
];

async function saveStyle(){
  const { isNew, style: s } = state.drawer;
  const body = {};
  EDITABLE_FIELDS.forEach(f=>{
    const el = document.getElementById('f-'+f);
    if (el) body[f] = el.value;
  });
  const stageEl = document.getElementById('f-stage');
  if (stageEl) body.stage = stageEl.value;
  if (state.drawer.fromConceptNo) body.concept_ref = state.drawer.fromConceptNo;

  try {
    if (isNew) {
      const retailer = document.getElementById('f-retailer').value.trim();
      const department = document.getElementById('f-department').value;
      const styleNo = document.getElementById('f-style-no').value.trim();
      if (!retailer) { toast('Retailer is required'); return; }
const { style } = await api('/api/styles', { method:'POST', body: JSON.stringify({ retailer, department, style_no: styleNo, buyer: body.buyer, description: body.description }) });
      // second call to save the rest of the fields captured on this first save
      await api('/api/styles/'+style.id, { method:'PUT', body: JSON.stringify(body) });
      if (state.drawer.fromConceptId) {
        const conceptId = state.drawer.fromConceptId;
        await api('/api/concepts/'+conceptId+'/conversions', { method:'POST', body: JSON.stringify({ style_id: style.id, style_no: style.style_no }) });
        await api('/api/concepts/'+conceptId+'/copy-photos-to-style/'+style.id, { method:'POST' });
      }
      // Seed the Measurements tab from the concept's own spec category, if
      // it had one - a separate call (not part of the field PUT above) since
      // this is what actually copies the bank's POMs onto the new style, not
      // just a column write. Doesn't block the rest of creation succeeding -
      // e.g. the bank might genuinely have no POMs yet for that category.
      if (state.drawer.fromConceptSpecCategoryId) {
        try {
          await api('/api/styles/'+style.id+'/spec/select-category', { method:'POST', body: JSON.stringify({ spec_category_id: state.drawer.fromConceptSpecCategoryId }) });
        } catch (e) { toast(`${style.style_no} created, but its spec category couldn't be carried over: ${e.message}`); }
      }
      toast(`${style.style_no} created`);
    } else {
      await api('/api/styles/'+s.id, { method:'PUT', body: JSON.stringify(body) });
      toast('Saved');
    }
    closeDrawer();
    await loadStyles();
  } catch(e) {
    toast(e.message);
  }
}

async function deleteStyle(styleId, styleNo){
  if (!confirm(`Permanently delete ${styleNo}? This removes its comments and photos too, and can't be undone.`)) return;
  try {
    await api('/api/styles/'+styleId, { method:'DELETE' });
    state.styles = state.styles.filter(s => s.id !== styleId);
    closeDrawer();
    toast(`${styleNo} deleted`);
  } catch(e) {
    toast(e.message);
  }
}

function openDuplicateStyleModal(styleId, styleNo){
  state.modal = { type:'duplicateStyle', sourceId: styleId, sourceStyleNo: styleNo, busy:false, error:'' };
  render();
}
