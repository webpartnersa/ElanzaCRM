// ---- Concepts: sample/photo gallery, searchable by department + keyword ----
function initConceptsState(){
  if (!state.concepts) state.concepts = [];
  if (state.departmentFilterConcepts === undefined) state.departmentFilterConcepts = 'All';
  if (state.conceptSearch === undefined) state.conceptSearch = '';
}

async function loadConcepts(){
  initConceptsState();
  // Fabrics normally only loads up front for users with the separate
  // 'fabrics' section permission (app.js's init()) - the Concept drawer's
  // Fabric dropdown needs that same list, so fetch it here too (skipped
  // gracefully if this user can't reach Fabrics at all, since routes/
  // fabrics.js 403s otherwise and would sink the whole Promise.all).
  const canSeeFabrics = hasPerm(state.user, 'fabrics');
  // Factory dropdown source (see the Cost tab's Factory field below) - a
  // buyer never sees the Factory field at all (stripped server-side), and
  // the endpoint 403s them anyway, so skip the request entirely for them.
  const canSeeFactory = state.user.role !== 'buyer';
  const [{ concepts }, { categories }, { ranges }, fabricsResult, factoryResult] = await Promise.all([
    api('/api/concepts'),
    api('/api/spec-categories'),
    api('/api/size-ranges'),
    canSeeFabrics ? api('/api/fabrics') : Promise.resolve(null),
    canSeeFactory ? api('/api/concepts/factory-names') : Promise.resolve(null),
  ]);
  state.concepts = concepts;
  state.specCategories = categories;
  state.sizeRanges = ranges;
  if (fabricsResult) state.fabrics = fabricsResult.fabrics;
  if (factoryResult) state.factoryNames = factoryResult.factories;
  render();
}

function renderConceptsView(){
  initConceptsState();
  const canCreate = state.user.role !== 'buyer';
  const q = state.conceptSearch.trim().toLowerCase();
  const filtered = state.concepts.filter(c=>{
    if (state.departmentFilterConcepts !== 'All' && c.department !== state.departmentFilterConcepts) return false;
    if (q) {
      const hay = ((c.concept_no||'') + ' ' + (c.description||'') + ' ' + (c.tags||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return `
    <div class="topbar">
      <div><h1 class="display">Concepts</h1><p>${filtered.length} concept${filtered.length===1?'':'s'}</p></div>
      <div class="row-actions">
        <select id="concept-dept-filter" onchange="setConceptDeptFilter(this.value)" style="width:auto;">
          <option value="All" ${state.departmentFilterConcepts==='All'?'selected':''}>All departments</option>
          ${DEPARTMENTS.map(d=>`<option value="${d}" ${state.departmentFilterConcepts===d?'selected':''}>${d}</option>`).join('')}
        </select>
        <input id="concept-search" placeholder="Search code, description or tags..." value="${state.conceptSearch}" oninput="setConceptSearch(this.value)" style="width:220px;"/>
        ${canCreate ? `<button class="btn btn-ghost" onclick="openSpecManager()">Manage Spec Hierarchy</button>` : ''}
        ${canCreate ? `<button class="btn btn-ghost" onclick="openSizeManager()">Manage Size Ranges</button>` : ''}
        ${canCreate ? `<button class="btn btn-primary" onclick="openNewConcept()">+ New Concept</button>` : ''}
      </div>
    </div>
    <div class="concept-grid">
      ${filtered.map(renderConceptCard).join('') || '<div class="empty-state">No concepts yet.</div>'}
    </div>
    ${renderConceptDrawerHost()}
    ${renderSizeManagerHost()}
  `;
}

function renderConceptCard(c){
  return `
    <div class="concept-card" onclick="openConcept(${c.id})">
      ${c.cover_photo ? `<img class="concept-thumb" src="${c.cover_photo}"/>` : `<div class="concept-thumb concept-thumb-empty">No photo</div>`}
      ${c.has_cad ? `<span class="cad-badge">CAD</span>` : ''}
      <div class="concept-card-body">
        <div class="concept-no mono">${c.concept_no}</div>
        <div class="concept-desc">${c.description || '(no description)'}</div>
        <div class="badge">${c.department}</div>
      </div>
    </div>`;
}

function setConceptDeptFilter(v){ state.departmentFilterConcepts = v; render(); }
function setConceptSearch(v){
  state.conceptSearch = v;
  render();
  const el = document.getElementById('concept-search');
  if (el) {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
}

// ---- Concept drawer (its own overlay, independent of the style drawer) ----
function blankConceptDraft(){
  const draft = { id:null, department:DEPARTMENTS[0], description:'', source:'', concept_date: new Date().toISOString().slice(0,7), cost_estimate:'', factory:'Wofeng', shipping_date:'', size_range_id:'', fabric_code:'', composition:'', weight:'', buyer_rand_target:'', buyer_rsp_target:'', factory_target_price:'', factory_price:'', factory_cost_options:'' };
  CONCEPT_DETAIL_FIELDS.forEach(f => { draft[f.key] = ''; });
  return draft;
}

async function openConcept(id){
  // requests fetched alongside everything else so the Requests tab has its
  // history ready the moment it's clicked - tab switches only toggle CSS
  // visibility, they don't re-render (see setConceptDrawerTab), so this
  // can't be lazy-loaded on tab click without a special case there.
  // .catch() degrades gracefully for buyers (403'd, tab isn't shown to them
  // anyway - see canEdit gating in renderConceptDrawerBody).
  const [{ concept, photos, conversions, fabrics }, requestsRes] = await Promise.all([
    api('/api/concepts/'+id),
    api('/api/concepts/'+id+'/requests').catch(() => ({ requests: [] })),
  ]);
  state.conceptDrawer = { concept, photos, conversions, requests: requestsRes.requests || [], isNew:false, lightboxIndex:null, tab:'details', specCategoryId: concept.spec_category_id || null, floatPhotoId: null, extraFabrics: fabrics || [] };
  render();
}
// Nothing is created in the database until Save is clicked - the concept
// code is assigned then, from whatever department was actually selected.
// All fields (not just department/description) are editable immediately in
// this same draft, and selected photos are held as { file, url } pairs in
// pendingFiles (url is a local object-URL preview, revoked once no longer
// needed) so they can be shown as real thumbnails before upload, and
// uploaded for real only after the concept exists.
function openNewConcept(){
  state.conceptDrawer = { concept: blankConceptDraft(), photos: [], conversions: [], isNew:true, pendingFiles:[], lightboxIndex:null, tab:'details', specCategoryId: null, floatPendingIndex: 0, extraFabrics: [] };
  render();
}
// DOM-only tab switch, same fix as the Style drawer's setDrawerTab - both
// tab panels are always rendered at once (see renderConceptDrawerContent),
// just hidden via .active, so nothing needs rebuilding here. Calling the
// full render() instead would regenerate every field from
// state.conceptDrawer.concept, which is only updated at Save time - wiping
// out anything typed but not yet saved, and (worse) meant saveConcept()'s
// document.getElementById() lookups would silently miss whichever tab
// wasn't currently in the DOM, dropping those fields from the save entirely.
function setConceptDrawerTab(tab){
  state.conceptDrawer.tab = tab;
  document.querySelectorAll('.drawer .tabs .tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.drawer .drawer-body > [data-tab]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tab === tab);
  });
}
function closeConceptDrawer(){
  const d = state.conceptDrawer;
  if (d && d.pendingFiles) d.pendingFiles.forEach(p => URL.revokeObjectURL(p.url));
  state.conceptDrawer = null;
  render();
}

function renderConceptDrawerHost(){
  const open = !!state.conceptDrawer;
  const d = state.conceptDrawer;
  const lightboxIndex = d ? d.lightboxIndex : null;
  const photos = d ? d.photos : [];
  return `
    <div class="overlay ${open?'open':''}" onclick="closeConceptDrawer()"></div>
    ${open ? renderConceptFloatPhoto() : ''}
    <div class="drawer ${open?'open':''}">
      ${open ? renderConceptDrawerContent() : ''}
    </div>
    ${(lightboxIndex!=null && photos[lightboxIndex]) ? renderConceptLightbox(photos, lightboxIndex) : ''}
  `;
}

// Floats the enlarged photo to the left of the drawer, same "floats outside
// the drawer's own column" positioning as the Style drawer's
// renderFloatingMainPhoto() (drawer.js) - reuses its exact CSS classes.
// Which photo shows is driven by clicking a thumbnail below (setConceptFloatPhoto/
// setConceptFloatPending) or by this panel's own prev/next arrows. Handles
// both an existing concept's real (uploaded) photos - tracked by photo id so
// it survives reorders - and a brand-new concept's not-yet-uploaded
// pendingFiles, tracked by array index since those have no id yet.
function renderConceptFloatPhoto(){
  const d = state.conceptDrawer;
  if (!d) return '';
  if (d.isNew) {
    const list = d.pendingFiles || [];
    if (!list.length) return '';
    const idx = Math.min(d.floatPendingIndex || 0, list.length - 1);
    d.floatPendingIndex = idx;
    const current = list[idx];
    const hasMultiple = list.length > 1;
    return `
      <div class="drawer-float-photo">
        ${hasMultiple ? `<button class="float-photo-nav prev" onclick="event.stopPropagation(); shiftConceptFloatPending(-1)">&#8249;</button>` : ''}
        <img src="${current.url}"/>
        ${hasMultiple ? `<button class="float-photo-nav next" onclick="event.stopPropagation(); shiftConceptFloatPending(1)">&#8250;</button>` : ''}
        ${hasMultiple ? `<div class="float-photo-count">${idx+1} / ${list.length}</div>` : ''}
      </div>`;
  }
  const list = (d.photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (!list.length) return '';
  let idx = list.findIndex(p => p.id === d.floatPhotoId);
  if (idx === -1) idx = 0;
  d.floatPhotoId = list[idx].id;
  const current = list[idx];
  const hasMultiple = list.length > 1;
  return `
    <div class="drawer-float-photo">
      ${hasMultiple ? `<button class="float-photo-nav prev" onclick="event.stopPropagation(); shiftConceptFloatPhoto(-1)">&#8249;</button>` : ''}
      <img src="${current.path}" onclick="openConceptLightbox(${d.photos.indexOf(current)})"/>
      ${hasMultiple ? `<button class="float-photo-nav next" onclick="event.stopPropagation(); shiftConceptFloatPhoto(1)">&#8250;</button>` : ''}
      ${hasMultiple ? `<div class="float-photo-count">${idx+1} / ${list.length}</div>` : ''}
    </div>`;
}
// Patches just the floating photo element - same reasoning as
// setConceptDrawerTab: a full render() would rebuild every field from
// state.conceptDrawer.concept and drop anything typed but unsaved.
function shiftConceptFloatPhoto(delta){
  const d = state.conceptDrawer;
  const list = (d.photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (!list.length) return;
  let idx = list.findIndex(p => p.id === d.floatPhotoId);
  if (idx === -1) idx = 0;
  idx = (idx + delta + list.length) % list.length;
  d.floatPhotoId = list[idx].id;
  const el = document.querySelector('.drawer-float-photo');
  if (el) el.outerHTML = renderConceptFloatPhoto();
}
function setConceptFloatPhoto(photoId){
  state.conceptDrawer.floatPhotoId = photoId;
  const el = document.querySelector('.drawer-float-photo');
  if (el) el.outerHTML = renderConceptFloatPhoto();
  else render();
}
function shiftConceptFloatPending(delta){
  const d = state.conceptDrawer;
  const list = d.pendingFiles || [];
  if (!list.length) return;
  const cur = d.floatPendingIndex || 0;
  d.floatPendingIndex = (cur + delta + list.length) % list.length;
  const el = document.querySelector('.drawer-float-photo');
  if (el) el.outerHTML = renderConceptFloatPhoto();
}
function setConceptFloatPending(index){
  state.conceptDrawer.floatPendingIndex = index;
  const el = document.querySelector('.drawer-float-photo');
  if (el) el.outerHTML = renderConceptFloatPhoto();
  else render();
}

function renderConceptLightbox(photos, index){
  const p = photos[index];
  return `
    <div class="lightbox" onclick="closeConceptLightbox()">
      <button class="lightbox-nav lightbox-prev" onclick="event.stopPropagation(); conceptLightboxNav(-1)" ${index<=0?'disabled':''}>&lsaquo;</button>
      <img src="${p.path}" onclick="event.stopPropagation()"/>
      <button class="lightbox-nav lightbox-next" onclick="event.stopPropagation(); conceptLightboxNav(1)" ${index>=photos.length-1?'disabled':''}>&rsaquo;</button>
      <button class="lightbox-close" onclick="closeConceptLightbox()">&times;</button>
      <div class="lightbox-count mono">${index+1} / ${photos.length}</div>
    </div>`;
}
function openConceptLightbox(index){ state.conceptDrawer.lightboxIndex = index; render(); }
function closeConceptLightbox(){ if (state.conceptDrawer) state.conceptDrawer.lightboxIndex = null; render(); }
function conceptLightboxNav(delta){
  const photos = state.conceptDrawer.photos;
  let idx = state.conceptDrawer.lightboxIndex + delta;
  if (idx < 0) idx = 0;
  if (idx > photos.length-1) idx = photos.length-1;
  state.conceptDrawer.lightboxIndex = idx;
  render();
}

// Drag-to-reorder: whichever photo ends up first becomes the board thumbnail.
let _conceptDragPhotoId = null;
function conceptPhotoDragStart(e, photoId){ _conceptDragPhotoId = photoId; e.dataTransfer.effectAllowed = 'move'; }
async function conceptPhotoDrop(e, targetPhotoId){
  e.preventDefault();
  if (_conceptDragPhotoId == null || _conceptDragPhotoId === targetPhotoId) return;
  const photos = state.conceptDrawer.photos;
  const fromIdx = photos.findIndex(p=>p.id===_conceptDragPhotoId);
  const toIdx = photos.findIndex(p=>p.id===targetPhotoId);
  _conceptDragPhotoId = null;
  if (fromIdx===-1 || toIdx===-1) return;
  const reordered = [...photos];
  const [moved] = reordered.splice(fromIdx,1);
  reordered.splice(toIdx,0,moved);
  state.conceptDrawer.photos = reordered;
  render();
  try {
    await api('/api/concepts/'+state.conceptDrawer.concept.id+'/photos/reorder', { method:'PUT', body: JSON.stringify({ order: reordered.map(p=>p.id) }) });
    await loadConcepts();
  } catch(err) { toast('Could not save new photo order'); }
}

async function updateConceptPhotoRole(conceptId, photoId, role){
  try {
    const { photos } = await api('/api/concepts/'+conceptId+'/photos/'+photoId+'/role', { method:'PUT', body: JSON.stringify({ role }) });
    state.conceptDrawer.photos = photos;
    render();
  } catch(e) { toast(e.message); }
}

// Simple text/textarea/date fields with no cross-field wiring - single
// source of truth for the drawer's inputs plus the sync/save paths below,
// so adding one only means editing this list once. Fabric/Composition/
// Weight and Spec/Sizes are handled separately since they have their own
// autofill/cascading wiring.
const CONCEPT_DETAIL_FIELDS = [
  { key:'wash', label:'Wash', type:'textarea' },
  { key:'colour', label:'Colour', type:'textarea' },
  { key:'print', label:'Print', type:'textarea' },
  { key:'embroidery_applique', label:'Embroidery / Applique', type:'textarea' },
  { key:'topstitching', label:'Topstitching', type:'textarea' },
  { key:'trims', label:'Trims', type:'textarea' },
  { key:'styling', label:'Styling', type:'textarea' },
  { key:'units', label:'Units', type:'text' },
  { key:'packing', label:'Packing', type:'textarea' },
  { key:'labels', label:'Labels', type:'textarea' },
  { key:'dc_date', label:'DC Date', type:'date' },
];
function renderConceptDetailField(key, canEdit){
  const f = CONCEPT_DETAIL_FIELDS.find(x=>x.key===key);
  const v = state.conceptDrawer.concept[f.key] || '';
  const id = 'cf-'+f.key;
  // Print/Embroidery-Applique drive the fabric-report-requirement banner
  // below them - live, via oninput, without a full render() (same
  // reasoning as updateConceptMargin). DC Date drives Shipping Date the
  // same way - see updateConceptShippingDateFromDc.
  const onchange = (key === 'print' || key === 'embroidery_applique') ? ` oninput="updateFabricReportRequirement()"`
    : (key === 'dc_date') ? ` onchange="updateConceptShippingDateFromDc()"` : '';
  if (f.type === 'textarea') return `<div class="field"><label>${f.label}</label><textarea id="${id}" ${canEdit?'':'disabled'}${onchange}>${v}</textarea></div>`;
  if (f.type === 'date') return `<div class="field"><label>${f.label}</label><input type="date" id="${id}" value="${v}" ${canEdit?'':'disabled'}${onchange}/></div>`;
  return `<div class="field"><label>${f.label}</label><input id="${id}" value="${v}" ${canEdit?'':'disabled'}/></div>`;
}

// Whenever a concept has Print or Embroidery/Applique details, an
// additional Print/Embellishment fabric report is required on top of the
// base/bulk fabric report (see routes/fabrics.js's fabric_test_reports.
// report_type) - this banner is a reminder, not an automated compliance
// check against what's actually been uploaded.
function conceptNeedsPrintReport(c){
  return !!((c.print && c.print.trim()) || (c.embroidery_applique && c.embroidery_applique.trim()));
}
function renderFabricReportRequirement(needsReport){
  return needsReport
    ? `<div class="hint" style="color:var(--stitch-red);font-weight:700;">⚠ Print or Embroidery/Applique has details - an additional Print/Embellishment fabric report is required, on top of the base fabric report.</div>`
    : `<div class="hint">No print or embroidery/applique details entered - the base fabric report is sufficient.</div>`;
}
// Called via oninput on the Print/Embroidery-Applique fields - reads
// straight from the DOM (both fields already exist there by the time this
// fires) and patches only this one div, same reasoning as
// updateConceptMargin: no full render(), so nothing typed elsewhere in the
// drawer is ever at risk.
function updateFabricReportRequirement(){
  const c = {
    print: document.getElementById('cf-print').value,
    embroidery_applique: document.getElementById('cf-embroidery_applique').value,
  };
  const el = document.getElementById('cf-fabric-report-requirement');
  if (el) el.innerHTML = renderFabricReportRequirement(conceptNeedsPrintReport(c));
}

// Margin the buyer makes = (RSP - what they pay us) / RSP - standard retail
// margin math. Buyer Rand Target is entered ex VAT, but RSP is VAT-inclusive
// (it's what the shopper pays), so VAT (15%) is added to the rand figure
// before comparing the two - otherwise the margin comes out overstated.
// Purely derived from the two Buyer Rand/RSP Target fields, so it's never
// stored on its own - just recomputed for display, live as either field
// changes (updateConceptMargin patches only the display span, not the wider
// drawer, so typing here never risks losing anything typed elsewhere in the
// drawer - see patchConceptDrawerBody's reasoning).
const VAT_RATE = 0.15;
function computeConceptMargin(rand, rsp){
  const r = parseFloat(rand), s = parseFloat(rsp);
  if (!r || !s || isNaN(r) || isNaN(s)) return null;
  const randInclVat = r * (1 + VAT_RATE);
  return ((s - randInclVat) / s) * 100;
}
function formatConceptMargin(rand, rsp){
  const m = computeConceptMargin(rand, rsp);
  return m === null ? '—' : m.toFixed(1) + '%';
}
function updateConceptMargin(){
  const rand = document.getElementById('cf-buyer_rand_target').value;
  const rsp = document.getElementById('cf-buyer_rsp_target').value;
  const el = document.getElementById('cf-margin-display');
  if (el) el.textContent = formatConceptMargin(rand, rsp);
}

// DC Date is the one actually set by hand - Shipping Date defaults to 55
// days before it, same "live default, stays freely editable afterward"
// pattern as the fabric-code autofill (onConceptFabricPicked) rather than
// a locked/computed-only field, in case a real shipment ends up needing a
// different date than the flat 55-day rule.
function updateConceptShippingDateFromDc(){
  const dcEl = document.getElementById('cf-dc_date');
  const shipEl = document.getElementById('cf-shipping_date');
  if (!dcEl || !shipEl || !dcEl.value) return;
  const d = new Date(dcEl.value + 'T00:00:00');
  d.setDate(d.getDate() - 55);
  shipEl.value = d.toISOString().slice(0, 10);
}

// Factory dropdown, sourced from Contacts' Factory-position company names
// (see GET /api/concepts/factory-names) rather than free text - keeps this
// field consistent with whatever's saved in Contacts instead of drifting
// into ad hoc spellings. If the concept already has a factory name saved
// that isn't (or isn't yet) in Contacts - e.g. older data, or the contact
// got renamed - that value is still shown as a selectable option so it
// isn't silently dropped, just flagged as unmatched.
function renderConceptFactorySelect(current){
  const names = state.factoryNames || [];
  const known = names.includes(current);
  const opts = [`<option value="">— Select factory —</option>`];
  if (current && !known) opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not in Contacts)</option>`);
  names.forEach(n => opts.push(`<option value="${escapeHtml(n)}" ${n===current?'selected':''}>${escapeHtml(n)}</option>`));
  return `<select id="cf-factory">${opts.join('')}</select>`;
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Costing request: everything the factory needs to quote, built from
// this concept's saved Details + Costing fields. Deliberately excludes
// Buyer Rand/RSP Target (and the % margin derived from them) - that's this
// business's own retail pricing, not something to hand to the factory
// while asking them for a price. This plain-text version is the
// text/plain clipboard fallback for the HTML table version below, used by
// the "Copy to clipboard" button - a deliberate second path alongside
// "Send costing request" for when the user wants to add a custom message
// or otherwise edit the email before it actually goes out. ----
// Only ever emits a line for a field that actually has a value - an empty
// concept field means the label is skipped entirely, not shown blank/with
// a "-" placeholder. Weight, Composition, and Cost estimate (R) are
// deliberately left out of the costing request altogether (not just
// blank-skipped) - Cost estimate is this business's own internal Rand
// figure, not something to hand to the factory when asking them to quote.
function costingField(label, value){
  return (value != null && String(value).trim()) ? [`${label}: ${value}`] : [];
}
function generateConceptCostingDoc(c){
  return [
    `QUOTATION REQUEST`,
    `Concept: ${c.concept_no} - ${c.description||''}`,
    ...costingField('Department', c.department),
    ...costingField('Shipping Date', c.shipping_date),
    ``,
    `DETAILS`,
    ...costingField('Fabric code', c.fabric_code),
    ...costingField('Colour', c.colour),
    ...costingField('Wash', c.wash),
    ...costingField('Print', c.print),
    ...costingField('Embroidery/Applique', c.embroidery_applique),
    ...costingField('Topstitching', c.topstitching),
    ...costingField('Trims', c.trims),
    ...costingField('Styling', c.styling),
    ...costingField('Units', c.units),
    ...costingField('Packing', c.packing),
    ...costingField('Labels', c.labels),
    ...costingField('Source', c.source),
    ...(c.spec_category_id ? costingField('Spec / Measurements', specCategoryPath(c.spec_category_id)) : []),
    ``,
    `QUOTATION`,
    ...costingField('Factory Target $ Price', c.factory_target_price ? '$'+c.factory_target_price : ''),
    ...costingField('Factory $ Price (quoted)', c.factory_price ? '$'+c.factory_price : ''),
    ...(c.factory_cost_options ? [``, `Factory cost options / alternatives:`, c.factory_cost_options] : []),
  ].join('\n');
}

// mailto: bodies are plain-text-only (RFC 6068) - there's no way to get a
// formatted, image-carrying body into an email through a mailto: link, in
// any browser. This builds a table-based, fully inline-styled HTML document
// instead and puts it on the clipboard alongside the plain-text fallback, so
// pasting into the opened draft carries the formatting and photos across -
// the closest a webpage can get to "email with photos" without actually
// sending the email itself. Table + inline-style (no <style> block, no
// classes) is deliberate: Gmail/Outlook's paste handlers strip external and
// class-based CSS but preserve inline styles on table cells.
function loadImageAsDataUrl(src){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not load ' + src));
    img.src = src;
  });
}

// Brand palette for the pasted-into-email document.
const EMAIL_DENIM = '#2F4869';
const EMAIL_DENIM_DEEP = '#1F3350';
const EMAIL_STITCH_RED = '#A63A3A';
const EMAIL_INK = '#1C2126';
const EMAIL_INK_SOFT = '#4A5058';
const EMAIL_LINE = '#D8D6CE';
const EMAIL_LINE_SOFT = '#E8E7E0';

// Chinese on hold for now (2026-08-06) - emailFieldRow/emailSectionHeading
// still take labelZh/valueZh (every call site below still passes them) but
// no longer render them, so a single-column English layout comes out
// without touching the ~20 call sites in buildCostingEmailHtml below. Twin
// of the same on-hold change in lib/conceptCostingEmailHtml.js (server-side
// send path) - this is the client-side "Copy to clipboard" path.
function emailFieldRow(labelEn, labelZh, valueEn, valueZh){
  if (!(valueEn != null && String(valueEn).trim())) return '';
  const en = escapeHtml(valueEn).replace(/\r?\n/g, '<br>');
  return `<tr>
    <td style="width:100%;padding:10px 0;border-bottom:1px solid ${EMAIL_LINE_SOFT};vertical-align:top;">
      <div style="font-size:9px;font-weight:bold;letter-spacing:.04em;text-transform:uppercase;color:${EMAIL_DENIM};margin:0 0 3px 0;">${escapeHtml(labelEn)}</div>
      <div style="font-size:13px;color:${EMAIL_INK};line-height:1.45;">${en}</div>
    </td>
  </tr>`;
}
function emailSectionHeading(labelEn, labelZh){
  return `<tr>
    <td style="padding:18px 0 6px 0;">
      <div style="font-size:12.5px;font-weight:bold;color:${EMAIL_DENIM_DEEP};">${escapeHtml(labelEn)}</div>
      <div style="border-bottom:2px solid ${EMAIL_STITCH_RED};width:28px;margin-top:5px;font-size:1px;line-height:1px;">&nbsp;</div>
    </td>
  </tr>`;
}
// Builds the full pasted-into-email document: letterhead, then every field
// as a matched EN/ZH row (same field set and order as generateConceptCostingDoc
// above), then one block per photo. `t` is the server's AI-translated field
// values and `labels` its static LABELS map (see
// /api/concepts/:id/costing-email-data / lib/conceptCostingTranslate.js).
function buildCostingEmailHtml(c, specPath, t, labels, logoDataUrl, photoBlocksHtml){
  const title = `${c.concept_no} - Quotation Request`;
  const subtitle = [c.description, c.department, c.concept_date].filter(Boolean).join('  ·  ');
  const money = v => v ? '' + v : '';

  const rows = [
    emailFieldRow(labels.shippingDate.en, labels.shippingDate.zh, c.shipping_date, c.shipping_date),
    emailFieldRow('Description', '款式描述', c.description, t.description),
    emailSectionHeading(labels.details.en, labels.details.zh),
    emailFieldRow(labels.fabricCode.en, labels.fabricCode.zh, c.fabric_code, c.fabric_code),
    emailFieldRow(labels.colour.en, labels.colour.zh, c.colour, t.colour),
    emailFieldRow(labels.wash.en, labels.wash.zh, c.wash, t.wash),
    emailFieldRow(labels.print.en, labels.print.zh, c.print, t.print),
    emailFieldRow(labels.embroidery.en, labels.embroidery.zh, c.embroidery_applique, t.embroidery_applique),
    emailFieldRow(labels.topstitching.en, labels.topstitching.zh, c.topstitching, t.topstitching),
    emailFieldRow(labels.trims.en, labels.trims.zh, c.trims, t.trims),
    emailFieldRow(labels.styling.en, labels.styling.zh, c.styling, t.styling),
    emailFieldRow(labels.units.en, labels.units.zh, c.units, c.units),
    emailFieldRow(labels.source.en, labels.source.zh, c.source, t.source),
    emailFieldRow(labels.packing.en, labels.packing.zh, c.packing, t.packing),
    emailFieldRow(labels.labels.en, labels.labels.zh, c.labels, t.labels),
    emailFieldRow(labels.spec.en, labels.spec.zh, specPath, t.specPath),
    emailSectionHeading(labels.costing.en, labels.costing.zh),
    emailFieldRow(labels.factoryTarget.en, labels.factoryTarget.zh, c.factory_target_price ? '$' + money(c.factory_target_price) : '', c.factory_target_price ? '$' + money(c.factory_target_price) : ''),
    emailFieldRow(labels.factoryQuoted.en, labels.factoryQuoted.zh, c.factory_price ? '$' + money(c.factory_price) : '', c.factory_price ? '$' + money(c.factory_price) : ''),
    emailFieldRow(labels.factoryOptions.en, labels.factoryOptions.zh, c.factory_cost_options, t.factory_cost_options),
  ].join('');

  const logoImg = logoDataUrl
    ? `<img src="${logoDataUrl}" height="34" style="display:block;border:0;" alt="Elanzas">`
    : `<div style="font-size:16px;font-weight:bold;letter-spacing:.08em;color:${EMAIL_DENIM_DEEP};">ELANZAS</div>`;

  return `<table width="700" cellpadding="0" cellspacing="0" border="0" style="width:700px;max-width:100%;font-family:Arial,Helvetica,sans-serif;border-collapse:collapse;">
    <tr>
      <td style="border-bottom:2px solid ${EMAIL_DENIM_DEEP};padding-bottom:12px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">${logoImg}</td>
          <td align="right" style="vertical-align:bottom;">
            <div style="font-size:16px;font-weight:bold;color:${EMAIL_DENIM_DEEP};">${escapeHtml(title)}</div>
            ${subtitle ? `<div style="font-size:10.5px;color:${EMAIL_INK_SOFT};margin-top:4px;">${escapeHtml(subtitle)}</div>` : ''}
          </td>
        </tr></table>
      </td>
    </tr>
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
    </td></tr>
    ${photoBlocksHtml}
    <tr><td style="border-top:1px solid ${EMAIL_LINE};padding-top:10px;">
      <div style="font-size:9.5px;color:${EMAIL_INK_SOFT};">Elanzas &middot; Quotation Request</div>
    </td></tr>
  </table>`;
}

async function emailConceptCostingRequest(){
  const c = state.conceptDrawer.concept;
  const subject = `Quotation - ${c.concept_no} - ${c.description||''}`;
  const photos = (state.conceptDrawer.photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  const bodyText = generateConceptCostingDoc(c);

  toast('Preparing quotation request...');
  try {
    const [dataRes, logoDataUrl, imageDataUrls] = await Promise.all([
      fetch('/api/concepts/' + c.id + '/costing-email-data').then(r => {
        if (!r.ok) return r.json().catch(() => ({})).then(d => Promise.reject(new Error(d.error || 'Failed to prepare costing request')));
        return r.json();
      }),
      loadImageAsDataUrl('/img/main-LOGO-transparent.PNG').catch(() => null),
      Promise.all(photos.map(p => loadImageAsDataUrl(p.path).catch(() => null))),
    ]);
    const validImages = imageDataUrls.filter(Boolean);
    const labels = dataRes.labels;
    const photoBlocksHtml = validImages.map((url, i) => {
      const capEn = `${labels.referencePhoto.en} ${i + 1} OF ${validImages.length}`;
      return `<tr><td style="padding-top:16px;">
        <div style="font-size:9px;font-weight:bold;color:${EMAIL_DENIM};">${escapeHtml(capEn)}</div>
        <img src="${url}" style="max-width:660px;width:100%;height:auto;display:block;margin-top:6px;border:1px solid ${EMAIL_LINE};" alt="">
      </td></tr>`;
    }).join('');

    const html = buildCostingEmailHtml(dataRes.concept, dataRes.specPath, dataRes.translations || {}, labels, logoDataUrl, photoBlocksHtml);

    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([bodyText], { type: 'text/plain' }),
      })
    ]);
    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}`;
    toast('Quotation request copied - paste (Cmd/Ctrl+V) into the email body');
  } catch(e) {
    toast('Could not prepare the quotation request: ' + e.message);
  }
}

// Inline "who does this go to" step before actually sending (see
// POST /api/concepts/:id/send-request) - never fires the send without the
// user seeing and confirming a recipient first, even when a saved Factory
// contact auto-matches. Prefill comes from GET /:id/factory-contact
// matching this concept's free-text Factory field against saved Factory
// contacts' company names (see routes/concepts.js). Shared by every request
// type (see openRequestComposer) - only the Cost type skips the message
// box, since its body is built from the concept's own Details/Costing
// fields instead (see emailConceptCostingRequest / the send-request route).
// Every successful send is logged server-side to concept_requests and
// immediately reflected in this tab's own history list below - see the
// Requests nav section (public/js/requests.js) for the all-concepts view.
function renderRequestComposer(){
  const d = state.conceptDrawer;
  const composer = d.composer;
  if (!composer) return '';
  const isCost = composer.type === 'cost';
  const emailContacts = (composer.contacts || []).filter(c => c.email);
  const contactOpts = emailContacts.map(c =>
    `<option value="${c.email}">${c.first_name} ${c.last_name} - ${c.company || ''}</option>`
  ).join('');
  // "Send to" also accepts multiple comma-separated addresses (see
  // parseRecipients in lib/mailer.js) - these buttons are just a quicker way
  // to add a second (or third) saved contact than typing their email by
  // hand, for e.g. cc'ing both a factory's merchandiser and their sample
  // room on the same request.
  const currentEmails = (composer.to || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const addButtons = emailContacts.filter(c => !currentEmails.includes(c.email.toLowerCase())).map(c =>
    `<button type="button" class="btn btn-ghost btn-sm" onclick="addRequestRecipient('${c.email.replace(/'/g,"\\'")}')">+ ${c.first_name} ${c.last_name}</button>`
  ).join('');
  return `
    <div class="field" style="margin-top:14px;background:var(--line-soft);padding:12px;border-radius:var(--radius);">
      <label>${REQUEST_TYPES[composer.type].en}</label>
      ${isCost
        ? `<div class="hint" style="margin:2px 0 0;">Built from this concept's saved Details and Costing fields - save first if you've just made changes.</div>`
        : `<textarea id="cf-request-message" placeholder="What do you need from the factory?" style="margin-top:6px;">${escapeHtml(composer.message||'')}</textarea>`}
      <label style="margin-top:10px;display:block;">Send to</label>
      <input id="cf-request-to" value="${composer.to || ''}" placeholder="factory@example.com" list="cf-request-to-list" onchange="syncRequestComposerTo(this.value)"/>
      <datalist id="cf-request-to-list">${contactOpts}</datalist>
      <div class="hint" style="margin-top:4px;">Separate multiple addresses with a comma to send to more than one recipient.</div>
      ${addButtons ? `<div class="row-actions" style="margin-top:8px;flex-wrap:wrap;">${addButtons}</div>` : ''}
      ${composer.matchName
        ? `<div class="hint" style="margin-top:4px;">Matched saved contact: ${composer.matchName}</div>`
        : `<div class="hint" style="margin-top:4px;">No saved Factory contact matched this concept's Factory field (${escapeHtml(d.concept.factory || '(not set)')}) - pick a saved contact above or type an email. Add factory contacts under Contacts.</div>`}
      <div class="row-actions" style="margin-top:10px;">
        <button class="btn btn-ghost" onclick="closeRequestComposer()">Cancel</button>
        ${isCost ? `<button class="btn btn-ghost" onclick="emailConceptCostingRequest()">Copy to clipboard</button>` : ''}
        <button class="btn btn-primary" onclick="sendRequestNow()">Send</button>
      </div>
    </div>`;
}
// Keeps composer.to in sync with manual edits to the input, so the "+ Add"
// buttons below it (which read/write composer.to) don't clobber typing done
// directly in the field between renders.
function syncRequestComposerTo(value){
  if (state.conceptDrawer && state.conceptDrawer.composer) state.conceptDrawer.composer.to = value;
}
function addRequestRecipient(email){
  const d = state.conceptDrawer;
  if (!d || !d.composer) return;
  const el = document.getElementById('cf-request-to');
  const current = (el ? el.value : d.composer.to) || '';
  const emails = current.split(',').map(s => s.trim()).filter(Boolean);
  if (!emails.some(e => e.toLowerCase() === email.toLowerCase())) emails.push(email);
  d.composer.to = emails.join(', ');
  patchConceptDrawerBody();
}
async function openRequestComposer(type){
  const d = state.conceptDrawer;
  d.composer = { type, to: '', matchName: '', contacts: [], message: '' };
  patchConceptDrawerBody();
  try {
    const { match, factoryContacts } = await api('/api/concepts/' + d.concept.id + '/factory-contact');
    d.composer.contacts = factoryContacts || [];
    if (match && match.email) {
      d.composer.to = match.email;
      d.composer.matchName = `${match.first_name} ${match.last_name}${match.company ? ' - ' + match.company : ''}`;
    }
    patchConceptDrawerBody();
  } catch(e) { /* composer still usable without a prefill */ }
}
function closeRequestComposer(){
  if (state.conceptDrawer) state.conceptDrawer.composer = null;
  patchConceptDrawerBody();
}
// Stays in the drawer on success (rather than navigating away to the main
// Requests list, like the very first version of this did) - the concept's
// own request history right below the composer is now the confirmation
// that the send went out, and staying put means sending a second request
// type for the same concept (e.g. cost, then a sample request once the
// price works) doesn't mean re-opening the drawer from scratch.
async function sendRequestNow(){
  const d = state.conceptDrawer;
  const composer = d.composer;
  const to = document.getElementById('cf-request-to').value.trim();
  if (!to) { toast('Enter a recipient email'); return; }
  let message = '';
  if (composer.type !== 'cost') {
    message = document.getElementById('cf-request-message').value.trim();
    if (!message) { toast('Enter a message for this request'); return; }
  }
  try {
    toast('Sending ' + REQUEST_TYPES[composer.type].en.toLowerCase() + '...');
    await api('/api/concepts/' + d.concept.id + '/send-request', { method:'POST', body: JSON.stringify({ request_type: composer.type, to, message }) });
    toast(REQUEST_TYPES[composer.type].en + ' sent to ' + to);
    d.composer = null;
    await loadConceptRequests();
  } catch(e) {
    toast('Could not send: ' + e.message);
  }
}

// This concept's own request history - fetched up front in openConcept()
// so it's ready the moment the Requests tab is clicked (tab switches just
// toggle CSS visibility, they don't re-render - see setConceptDrawerTab),
// and re-fetched here after a send or a status/reminder action so the tab
// reflects it immediately without needing the whole drawer reopened.
async function loadConceptRequests(){
  const d = state.conceptDrawer;
  if (!d || !d.concept || !d.concept.id) return;
  try {
    const { requests } = await api('/api/concepts/' + d.concept.id + '/requests');
    d.requests = requests;
    patchConceptDrawerBody();
  } catch(e) { /* non-critical - tab just shows nothing until this succeeds */ }
}

function renderConceptRequestsTab(){
  const d = state.conceptDrawer;
  const requests = d.requests || [];
  const typeButtons = Object.keys(REQUEST_TYPES).map(type =>
    `<button class="btn btn-ghost btn-sm" onclick="openRequestComposer('${type}')">${REQUEST_TYPES[type].en}</button>`
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
  `).join('') || `<tr><td colspan="5"><div class="empty-state">No requests sent yet for this concept.</div></td></tr>`;

  return `
    <div class="field"><label>Send a new request</label></div>
    <div class="row-actions" style="flex-wrap:wrap;row-gap:8px;">${typeButtons}</div>
    ${renderRequestComposer()}
    <div class="field" style="margin-top:22px;"><label>Sent so far</label></div>
    <table class="contacts-table">
      <thead><tr><th>Type</th><th>Sent to</th><th>Sent</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Live lookup against the already-loaded fabrics list, same pattern as
// onFabricCodePicked() in shipping.js - unconditionally overwrites
// composition/weight on pick, but both stay freely editable afterward.
// The field itself is a datalist-backed input rather than a strict <select>
// so a fabric that isn't in the database yet can still be typed in by hand.
function onConceptFabricPicked(code){
  syncConceptDraftFromDom();
  const d = state.conceptDrawer;
  d.concept.fabric_code = code;
  const fab = (state.fabrics||[]).find(f=>f.code===code);
  if (fab) {
    d.concept.composition = fab.composition || '';
    d.concept.weight = fab.weight || '';
  }
  patchConceptDrawerBody();
}

// A multi-piece concept (e.g. a dungaree + t-shirt set) needs more than one
// fabric, each on its own piece - these are the "+ Add Fabric" slots beyond
// the concept's own primary fabric_code/composition/weight. Each slot keeps
// its own composition/weight, visible individually rather than merged into
// one field here - a combined "Dungaree: ... / T-Shirt: ..." string only
// gets built downstream (export, etc), never live in the drawer or in the
// database, so each piece stays easy to read and edit on its own.
function syncExtraFabricsFromDom(){
  (state.conceptDrawer.extraFabrics||[]).forEach((ef,i) => {
    const prefixEl = document.getElementById('ef-prefix-'+i);
    const compEl = document.getElementById('ef-composition-'+i);
    const weightEl = document.getElementById('ef-weight-'+i);
    if (prefixEl) ef.prefix = prefixEl.value;
    if (compEl) ef.composition = compEl.value;
    if (weightEl) ef.weight = weightEl.value;
  });
}

function addExtraFabric(){
  syncConceptDraftFromDom();
  syncExtraFabricsFromDom();
  state.conceptDrawer.extraFabrics = [...(state.conceptDrawer.extraFabrics||[]), { prefix:'', fabric_code:'', composition:'', weight:'' }];
  patchConceptDrawerBody();
}

function removeExtraFabric(i){
  syncConceptDraftFromDom();
  syncExtraFabricsFromDom();
  state.conceptDrawer.extraFabrics.splice(i, 1);
  patchConceptDrawerBody();
}

function onExtraFabricPicked(i, code){
  syncConceptDraftFromDom();
  syncExtraFabricsFromDom();
  const d = state.conceptDrawer;
  const ef = d.extraFabrics[i];
  ef.fabric_code = code;
  const fab = (state.fabrics||[]).find(f=>f.code===code);
  ef.composition = fab ? (fab.composition||'') : '';
  ef.weight = fab ? (fab.weight||'') : '';
  patchConceptDrawerBody();
}

// Just the .drawer-body's inner content (both tab panels, or the single
// details view for a not-yet-created concept) - split out from
// renderConceptDrawerContent() so field changes that need to redraw part of
// the form (spec picker, department, fabric autofill) can patch only this
// via patchConceptDrawerBody() instead of a full render(), which would
// destroy and recreate .drawer-body and reset its scroll position back to
// the top every time.
function renderConceptDrawerBody(){
  const { concept: c, photos, conversions, isNew, tab, pendingFiles, extraFabrics } = state.conceptDrawer;
  const fabricSlots = extraFabrics || [];
  const canEdit = state.user.role !== 'buyer';
  const currentTab = tab || 'details';
  const deptOptions = DEPARTMENTS.map(d=>`<option value="${d}" ${c.department===d?'selected':''}>${d}</option>`).join('');

  // CAD-role and labeled cad_detail photos live only in the CAD tab now, not in the main grid.
  const nonCadCount = (photos||[]).filter(p=>p.role!=='cad' && p.role!=='cad_detail').length;
  const grid = nonCadCount ? `
    <div class="photo-grid">
      ${photos.map((p,i)=> (p.role==='cad'||p.role==='cad_detail') ? '' : `
        <div class="photo-thumb-wrap" draggable="${canEdit}"
          ondragstart="conceptPhotoDragStart(event, ${p.id})"
          ondragover="event.preventDefault()"
          ondrop="conceptPhotoDrop(event, ${p.id})">
          <img class="photo-thumb" src="${p.path}" onclick="setConceptFloatPhoto(${p.id})"/>
          ${photos[0] && photos[0].id===p.id ? `<span class="cover-badge">Main</span>` : ''}
          ${canEdit ? `<button class="photo-remove" onclick="event.stopPropagation(); removeConceptPhoto(${c.id}, ${p.id})">&times;</button>` : ''}
          ${canEdit ? `
            <select class="role-select" onclick="event.stopPropagation()" onchange="updateConceptPhotoRole(${c.id}, ${p.id}, this.value)">
              <option value="reference" ${p.role!=='detail'&&p.role!=='cad'?'selected':''}>Reference</option>
              <option value="detail" ${p.role==='detail'?'selected':''}>Detail crop</option>
              <option value="cad" ${p.role==='cad'?'selected':''}>CAD sheet</option>
            </select>` : ''}
        </div>
      `).join('')}
    </div>
    ${canEdit && nonCadCount>1 ? `<div class="hint" style="margin-top:6px;">Drag a photo to reorder \u2014 the first one is used as the board thumbnail. Tag each photo's role below it.</div>` : ''}
  ` : `<div class="drawer-photo-placeholder">No photos yet</div>`;

  const hasCad = (photos||[]).some(p=>p.role==='cad');

  // For a not-yet-created concept, photos are held locally as { file, url }
  // pairs and shown as real thumbnails via the object-URL preview - nothing
  // is uploaded until Save, when the concept (and its code) first exists.
  const pendingGrid = (pendingFiles && pendingFiles.length) ? `
    <div class="photo-grid">
      ${pendingFiles.map((p,i)=>`
        <div class="photo-thumb-wrap">
          <img class="photo-thumb" src="${p.url}" onclick="setConceptFloatPending(${i})"/>
          <button class="photo-remove" onclick="removePendingConceptPhoto(${i})">&times;</button>
        </div>
      `).join('')}
    </div>
  ` : `<div class="drawer-photo-placeholder">No photos yet</div>`;

  const detailsTabHtml = `
      <div class="photo-section">
        ${isNew ? pendingGrid : grid}
        ${canEdit && isNew ? `
          <input type="file" id="concept-photo-input-new" accept="image/*" multiple style="display:none;" onchange="stagePendingConceptPhotos()"/>
          <div class="row-actions" style="margin-top:8px;">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('concept-photo-input-new').click()">+ Add photos</button>
          </div>
        ` : ''}
        ${canEdit && !isNew ? `
          <input type="file" id="concept-photo-input" accept="image/*" multiple style="display:none;" onchange="uploadConceptPhotos(${c.id})"/>
          <div class="row-actions" style="margin-top:8px;">
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('concept-photo-input').click()">+ Add photos</button>
          </div>
        ` : ''}
      </div>

      <div class="field">
        <label>Department</label>
        <select id="cf-department" ${canEdit?'':'disabled'} onchange="onConceptDeptChange(this.value)">${deptOptions}</select>
        ${!isNew ? `<div class="hint" style="margin-top:4px;">Changing this reassigns the concept code (currently ${c.concept_no}) to match the new department.</div>` : ''}
      </div>
      <div class="field">
        <label>Concept Code</label>
        <input id="cf-concept_no" value="${c.concept_no||''}" placeholder="${isNew?'Leave blank to auto-generate':''}" ${canEdit?'':'disabled'} style="text-transform:uppercase;"/>
      </div>
      <div class="field"><label>Description</label><textarea id="cf-description" ${canEdit?'':'disabled'}>${c.description||''}</textarea></div>
      <div class="field">
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <label style="margin-bottom:5px;">Fabric</label>
          ${!isNew && canEdit ? `<a href="javascript:void(0)" onclick="addExtraFabric()" style="font-size:12px; text-transform:none;">+ Add Fabric</a>` : ''}
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          ${fabricSlots.length ? `<input id="cf-fabric_prefix" placeholder="Piece (e.g. Dungaree)" value="${c.fabric_prefix||''}" style="width:140px;" ${canEdit?'':'disabled'}/>` : ''}
          <select id="cf-fabric_code" onchange="onConceptFabricPicked(this.value)" ${canEdit?'':'disabled'} style="flex:1;">
            <option value="" ${!c.fabric_code?'selected':''}>-</option>
            ${(state.fabrics||[]).map(f=>`<option value="${f.code}" ${c.fabric_code===f.code?'selected':''}>${f.code}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="row2">
        <div class="field"><label>Composition</label><input id="cf-composition" value="${c.composition||''}" ${canEdit?'':'disabled'}/></div>
        <div class="field"><label>Weight (oz)</label><input id="cf-weight" value="${c.weight||''}" ${canEdit?'':'disabled'}/></div>
      </div>
      ${fabricSlots.map((ef,i)=>`
        <div class="field" style="border:1px solid var(--line); border-radius:6px; padding:10px; margin-top:6px;">
          <div style="display:flex; gap:8px; align-items:center;">
            <input id="ef-prefix-${i}" placeholder="Piece (e.g. T-Shirt)" value="${ef.prefix||''}" style="width:140px;" ${canEdit?'':'disabled'}/>
            <select id="ef-fabric-${i}" onchange="onExtraFabricPicked(${i}, this.value)" ${canEdit?'':'disabled'} style="flex:1;">
              <option value="" ${!ef.fabric_code?'selected':''}>-</option>
              ${(state.fabrics||[]).map(f=>`<option value="${f.code}" ${ef.fabric_code===f.code?'selected':''}>${f.code}</option>`).join('')}
            </select>
            ${canEdit ? `<button type="button" class="btn btn-ghost btn-sm" onclick="removeExtraFabric(${i})" title="Remove this fabric">&times;</button>` : ''}
          </div>
          <div class="row2" style="margin-top:8px;">
            <div class="field"><label>Composition</label><input id="ef-composition-${i}" value="${ef.composition||''}" ${canEdit?'':'disabled'}/></div>
            <div class="field"><label>Weight (oz)</label><input id="ef-weight-${i}" value="${ef.weight||''}" ${canEdit?'':'disabled'}/></div>
          </div>
        </div>
      `).join('')}
      ${renderConceptDetailField('wash', canEdit)}
      ${renderConceptDetailField('colour', canEdit)}
      ${renderConceptDetailField('print', canEdit)}
      ${renderConceptDetailField('embroidery_applique', canEdit)}
      <div id="cf-fabric-report-requirement" class="field">${renderFabricReportRequirement(conceptNeedsPrintReport(c))}</div>
      ${renderConceptDetailField('topstitching', canEdit)}
      ${renderConceptDetailField('trims', canEdit)}
      ${renderConceptDetailField('styling', canEdit)}
      <div class="field">
        <label>Spec</label>
        ${renderSpecSelector(c.department, state.conceptDrawer.specCategoryId)}
      </div>
      ${renderConceptDetailField('units', canEdit)}
      <div class="field">
        <label>Sizes</label>
        <select id="cf-size_range_id" ${canEdit?'':'disabled'}>
          <option value="">-</option>
          ${(state.sizeRanges||[]).map(r=>`<option value="${r.id}" ${String(c.size_range_id)===String(r.id)?'selected':''}>${r.values.join(' / ')}</option>`).join('')}
        </select>
        <div class="hint" style="margin-top:4px;"><a href="javascript:void(0)" onclick="openSizeManager()">manage size ranges</a></div>
      </div>
      ${renderConceptDetailField('packing', canEdit)}
      ${renderConceptDetailField('labels', canEdit)}
      <div class="field"><label>Source</label>
        <select id="cf-source" ${canEdit?'':'disabled'}>
          <option value="" ${!c.source?'selected':''}>-</option>
          <option value="Buyer photo" ${c.source==='Buyer photo'?'selected':''}>Buyer photo</option>
          <option value="In-house sample" ${c.source==='In-house sample'?'selected':''}>In-house sample</option>
          <option value="Bought-in reference" ${c.source==='Bought-in reference'?'selected':''}>Bought-in reference</option>
        </select>
      </div>
      <div class="field"><label>Concept date</label><input type="month" id="cf-concept_date" value="${c.concept_date||''}" ${canEdit?'':'disabled'}/></div>
      ${canEdit ? `
        <div class="field"><label>Factory</label>${renderConceptFactorySelect(c.factory)}</div>
        <div class="row2">
          ${renderConceptDetailField('dc_date', canEdit)}
          <div class="field"><label>Shipping Date</label><input type="date" id="cf-shipping_date" value="${c.shipping_date||''}"/></div>
        </div>
        <div class="hint" style="margin-top:-8px;">Shipping Date is set automatically to 55 days before DC Date - editable afterward if it needs adjusting.</div>
      ` : ''}
      ${!isNew && conversions && conversions.length ? `
        <div class="field"><label>Converted to</label>
          <ul class="comment-list">
            ${conversions.map(cv=>`<li>${cv.style_no}</li>`).join('')}
          </ul>
        </div>` : ''}
      ${!isNew && canEdit ? `
        <div class="row-actions" style="margin-top:16px;">
          <button class="btn btn-primary" onclick="saveAndGenerateCad()">Save &amp; Generate CAD</button>
        </div>
        <div class="hint" style="margin-top:6px;">Saves this concept and generates a CAD from its first two reference photos, in the background.</div>
      ` : ''}`;

  // Everything money-related lives here rather than in Details, per the
  // user's request to manage costs/target/price in one place. % Margin is
  // never stored - see computeConceptMargin/updateConceptMargin above.
  const costsTabHtml = canEdit ? `
      <div class="field"><label>Cost estimate (R)</label><input id="cf-cost_estimate" value="${c.cost_estimate||''}"/></div>
      <div class="row2">
        <div class="field"><label>Buyer Rand Target</label><input id="cf-buyer_rand_target" value="${c.buyer_rand_target||''}" oninput="updateConceptMargin()"/></div>
        <div class="field"><label>Buyer RSP Target</label><input id="cf-buyer_rsp_target" value="${c.buyer_rsp_target||''}" oninput="updateConceptMargin()"/></div>
      </div>
      <div class="field">
        <label>% Margin</label>
        <div id="cf-margin-display" style="font-size:15px;font-weight:700;color:var(--ink);padding:6px 0;">${formatConceptMargin(c.buyer_rand_target, c.buyer_rsp_target)}</div>
        <div class="hint" style="margin-top:2px;">The % margin the buyer makes, from Buyer Rand Target (ex VAT, 15% added for this calc) vs Buyer RSP Target - recalculates as you type, nothing saved separately.</div>
      </div>
      <div class="row2">
        <div class="field"><label>Factory Target $ Price</label><input id="cf-factory_target_price" value="${c.factory_target_price||''}"/></div>
        <div class="field"><label>Factory $ Price</label><input id="cf-factory_price" value="${c.factory_price||''}"/></div>
      </div>
      <div class="field"><label>Factory Cost Options</label><textarea id="cf-factory_cost_options">${c.factory_cost_options||''}</textarea></div>
  ` : '';

  const requestsTabHtml = !isNew ? renderConceptRequestsTab() : `<div class="hint" style="margin-top:18px;">Save this concept first to send a request to the factory.</div>`;

  const cadPhoto = (photos||[]).find(p=>p.role==='cad');
  const cadIndex = cadPhoto ? photos.indexOf(cadPhoto) : -1;
  const cadTabHtml = `
      <div class="field" style="margin-bottom:18px;">
        <label>Concept summary</label>
        <div class="hint" style="font-size:12.5px;">${c.department} — ${c.description || '(no description)'}</div>
      </div>

      <div class="field"><label>Main CAD image</label></div>
      ${cadPhoto ? `
        <div class="cad-preview" onclick="openConceptLightbox(${cadIndex})">
          <img src="${cadPhoto.path}"/>
          ${canEdit ? `<button class="photo-remove" onclick="event.stopPropagation(); deleteCadPhoto(${c.id}, ${cadPhoto.id})">&times;</button>` : ''}
        </div>
      ` : `<div class="drawer-photo-placeholder">No CAD image yet</div>`}
      ${canEdit ? `
        <input type="file" id="cad-main-input" accept="image/*" style="display:none;" onchange="uploadCadMain()"/>
        <div class="row-actions" style="margin-top:8px;">
          <button class="btn btn-ghost btn-sm" onclick="generateOrRegenerateCad()">${cadPhoto ? 'Regenerate' : 'Generate'} with AI</button>
          <button class="btn btn-ghost btn-sm" onclick="document.getElementById('cad-main-input').click()">+ Upload / override</button>
        </div>
        <div class="hint" style="margin-top:6px;">AI generation uses this concept's first two reference photos from the Details tab as front/back. Runs in the background — this drawer will close and you can keep working; the board tag shows ✓ when it's ready.</div>
      ` : ''}

      ${canEdit && cadPhoto ? `
        <div class="row-actions" style="margin-top:10px;">
          <button class="btn btn-ghost" onclick="previewCadSheet()">Preview CAD sheet</button>
          <button class="btn btn-primary" onclick="downloadCadFile()">Download CAD file</button>
        </div>
        ${state.conceptDrawer.cadPreview ? `
          <div style="margin-top:12px;">
            <img src="${state.conceptDrawer.cadPreview.dataUrl}" style="width:100%; border:1px solid var(--line); border-radius:6px; display:block;"/>
            <div class="hint" style="margin-top:6px;">This is exactly what "Download CAD file" will produce as a PDF. Edited the description or photos since this was built? Click "Preview CAD sheet" again to refresh it.</div>
          </div>
        ` : ''}
      ` : ''}`;

  return isNew ? detailsTabHtml + costsTabHtml + requestsTabHtml : `
    <div class="tab-panel ${currentTab==='details'?'active':''}" data-tab="details">${detailsTabHtml}</div>
    ${canEdit ? `<div class="tab-panel ${currentTab==='costs'?'active':''}" data-tab="costs">${costsTabHtml}</div>` : ''}
    ${canEdit ? `<div class="tab-panel ${currentTab==='requests'?'active':''}" data-tab="requests">${requestsTabHtml}</div>` : ''}
    <div class="tab-panel ${currentTab==='cad'?'active':''}" data-tab="cad">${cadTabHtml}</div>
  `;
}

function renderConceptDrawerContent(){
  const { concept: c, photos, isNew, tab } = state.conceptDrawer;
  const canEdit = state.user.role !== 'buyer';
  const currentTab = tab || 'details';
  const hasCad = (photos||[]).some(p=>p.role==='cad');
  return `
    <div class="drawer-head">
      <h2>${isNew ? 'New Concept' : c.concept_no}</h2>
      <button class="drawer-close" onclick="closeConceptDrawer()">&times;</button>
    </div>
    ${!isNew ? `
      <div class="tabs">
        <button class="tab ${currentTab==='details'?'active':''}" data-tab="details" onclick="setConceptDrawerTab('details')">Details</button>
        ${canEdit ? `<button class="tab ${currentTab==='costs'?'active':''}" data-tab="costs" onclick="setConceptDrawerTab('costs')">Costs</button>` : ''}
        ${canEdit ? `<button class="tab ${currentTab==='requests'?'active':''}" data-tab="requests" onclick="setConceptDrawerTab('requests')">Requests</button>` : ''}
        <button class="tab ${currentTab==='cad'?'active':''}" data-tab="cad" onclick="setConceptDrawerTab('cad')">CAD${hasCad?' \u2713':''}</button>
      </div>
    ` : ''}
    <div class="drawer-body">${renderConceptDrawerBody()}</div>
    <footer class="drawer-actions">
      ${(!isNew && canEdit) ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteConcept(${c.id}, '${c.concept_no}')">Delete</button>` : ''}
      ${(!isNew && canEdit) ? `<button class="btn btn-ghost" onclick="shareConceptWhatsApp()">Share via WhatsApp</button>` : ''}
      ${(!isNew && canEdit) ? `<button class="btn btn-ghost" onclick="convertConceptToStyle(${c.id})">Convert to style</button>` : ''}
      ${canEdit ? `<button class="btn btn-primary" onclick="saveConcept()">${isNew ? 'Create concept' : 'Save changes'}</button>` : ''}
    </footer>`;
}

// Patches just .drawer-body's contents, preserving its scroll position -
// same reasoning as shiftConceptFloatPhoto patching .drawer-float-photo
// instead of calling render(). Falls back to a full render() if the drawer
// isn't actually open (shouldn't happen, but cheap to guard).
function patchConceptDrawerBody(){
  const el = document.querySelector('.drawer.open .drawer-body');
  if (!el) { render(); return; }
  el.innerHTML = renderConceptDrawerBody();
}

// ---- CAD tab: main AI/uploaded image, labeled detail-photo sidebar, and
// the composited PDF download. ----

// Auto-picks the concept's first two non-CAD photos as front/back - same
// convention saveAndGenerateCad() uses. Closes the drawer and backgrounds
// the request immediately since generation takes a while - the user can go
// on browsing/editing other concepts, and the board tag shows ✓ when ready.
function generateOrRegenerateCad(){
  const { concept: c, photos } = state.conceptDrawer;
  const sourcePhotos = (photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (sourcePhotos.length < 2) { toast('Add at least two reference photos on the Details tab first'); return; }
  const photoIds = [sourcePhotos[0].id, sourcePhotos[1].id];
  const conceptId = c.id;
  const conceptNo = c.concept_no;

  closeConceptDrawer();
  toast(`Generating CAD for ${conceptNo} in the background — carry on working, it'll show as ready on its tag`);

  api('/api/concepts/'+conceptId+'/generate-cad-ai', { method:'POST', body: JSON.stringify({ photoIds }) })
    .then(async () => {
      await loadConcepts();
      toast(`${conceptNo}'s CAD is ready`);
    })
    .catch(e => {
      toast(`CAD generation failed for ${conceptNo}: ` + e.message);
    });
}

// Manual override path - uploads a real file directly as the main CAD
// image, replacing whatever's there (AI-generated or not).
async function uploadCadMain(){
  const input = document.getElementById('cad-main-input');
  if (!input.files || !input.files.length) return;
  const c = state.conceptDrawer.concept;
  const formData = new FormData();
  formData.append('photo', input.files[0]);
  try {
    const res = await fetch('/api/concepts/'+c.id+'/cad-main', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.conceptDrawer.photos = data.photos;
    state.conceptDrawer.cadPreview = null;
    render();
    await loadConcepts();
    toast('CAD image uploaded');
  } catch(e) { toast(e.message); }
}

function loadImageEl(src){
  return new Promise((resolve,reject)=>{ const img=new Image(); img.onload=()=>resolve(img); img.onerror=reject; img.src=src; });
}
function drawContain(ctx, img, x, y, w, h){
  const scale = Math.min(w/img.width, h/img.height);
  const dw = img.width*scale, dh = img.height*scale;
  ctx.drawImage(img, x+(w-dw)/2, y+(h-dh)/2, dw, dh);
}

// Simple word-wrap for canvas text, since fillText doesn't wrap on its own.
// Respects existing line breaks (e.g. a bullet list typed with Enter).
function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight){
  let curY = y;
  (text || '').split('\n').forEach(paragraph => {
    if (!paragraph.trim()) { curY += lineHeight; return; }
    const words = paragraph.split(/\s+/);
    let line = '';
    words.forEach(word => {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, curY);
        line = word;
        curY += lineHeight;
      } else {
        line = test;
      }
    });
    if (line) { ctx.fillText(line, x, curY); curY += lineHeight; }
  });
  return curY;
}

// Builds the branded page - CAD artwork filling the left ~80%, and a right
// sidebar with the logo, concept code, and description stacked below it -
// onto a canvas, returned as a PNG data URL. Shared by the preview and the
// download, so what you see in the preview is exactly what ends up in the PDF.
async function buildCadSheetDataUrl(){
  const c = state.conceptDrawer.concept;
  const photos = state.conceptDrawer.photos || [];
  const cadPhoto = photos.find(p => p.role === 'cad');
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
  const logoW = 200, logoH = logoW * (640 / 594); // E-Logo-concept.PNG's native ratio

  try {
    const logo = await loadImageEl('/img/E-Logo-concept.PNG');
    ctx.drawImage(logo, sbX, 70, logoW, logoH);
  } catch(e) { /* logo optional - layout below doesn't depend on it loading */ }

  ctx.fillStyle = '#1c2833';
  ctx.textAlign = 'left';
  ctx.font = 'bold 46px Oswald, sans-serif';
  ctx.fillText(c.concept_no, sbX, 70 + logoH + 70);
  ctx.font = '24px "IBM Plex Sans", sans-serif';
  wrapCanvasText(ctx, c.description || '', sbX, 70 + logoH + 112, textMaxWidth, 32);

  return { dataUrl: canvas.toDataURL('image/png') };
}

// Composites the sheet and shows it inline in the CAD tab so you can check
// it before committing to a download - the "Download PDF" button that
// appears reuses this exact composited image, so what you saw is what you get.
async function previewCadSheet(){
  try {
    const built = await buildCadSheetDataUrl();
    if (!built) { toast('Generate or upload a main CAD image first'); return; }
    state.conceptDrawer.cadPreview = built;
    render();
  } catch(e) {
    toast('Could not build preview: ' + e.message);
  }
}

// Sends the composited sheet to the server to be wrapped into a real
// downloadable PDF. Reuses the current preview if there is one so the
// downloaded file matches what was shown; otherwise builds it fresh.
async function downloadCadFile(){
  const c = state.conceptDrawer.concept;
  try {
    const built = state.conceptDrawer.cadPreview || await buildCadSheetDataUrl();
    if (!built) { toast('Generate or upload a main CAD image first'); return; }

    toast('Building PDF...');
    const res = await fetch('/api/concepts/' + c.id + '/export-cad-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: built.dataUrl })
    });
    if (!res.ok) { const d = await res.json().catch(()=>({})); throw new Error(d.error || 'Export failed'); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${c.concept_no}.pdf`; a.click();
    URL.revokeObjectURL(url);
    toast('PDF downloaded');
  } catch(e) {
    toast('Could not download CAD file: ' + e.message);
  }
}

// Copies every draft field's live DOM value back into state.conceptDrawer.
// concept before a render() that would otherwise rebuild the form from the
// (stale) state object and silently discard anything typed since the last
// sync - e.g. selecting photos re-renders to show the new thumbnail, and
// without this, that reset every other field the user had already filled in.
function syncConceptDraftFromDom(){
  const d = state.conceptDrawer;
  if (!d) return;
  const fields = ['concept_no','department','description','source','concept_date','cost_estimate','factory','shipping_date','size_range_id',
    'fabric_code','fabric_prefix','composition','weight','buyer_rand_target','buyer_rsp_target','factory_target_price','factory_price','factory_cost_options', ...CONCEPT_DETAIL_FIELDS.map(f=>f.key)];
  fields.forEach(f => {
    const el = document.getElementById('cf-'+f);
    if (el) d.concept[f] = el.value;
  });
  d.concept.spec_category_id = d.specCategoryId;
}

// A different department means a different spec tree entirely - the old
// pick almost certainly doesn't belong to it, so it's cleared rather than
// left pointing at a leaf from the wrong department.
function onConceptDeptChange(value){
  syncConceptDraftFromDom();
  state.conceptDrawer.concept.department = value;
  state.conceptDrawer.specCategoryId = null;
  patchConceptDrawerBody();
}

// Photos chosen before the concept exists are held as { file, url } pairs -
// url is a local object-URL so they can be shown as real thumbnails right
// away. Nothing is uploaded until Save, once the concept (and its id) exist.
function stagePendingConceptPhotos(){
  const input = document.getElementById('concept-photo-input-new');
  if (!input.files || !input.files.length) return;
  syncConceptDraftFromDom();
  const entries = Array.from(input.files).map(f => ({ file: f, url: URL.createObjectURL(f) }));
  state.conceptDrawer.pendingFiles = [...(state.conceptDrawer.pendingFiles||[]), ...entries];
  render();
}
function removePendingConceptPhoto(index){
  syncConceptDraftFromDom();
  const entry = state.conceptDrawer.pendingFiles[index];
  if (entry) URL.revokeObjectURL(entry.url);
  state.conceptDrawer.pendingFiles.splice(index, 1);
  render();
}

async function saveConcept(){
  const { isNew, concept: c } = state.conceptDrawer;
  if (isNew) {
    const department = document.getElementById('cf-department').value;
    if (!department) { toast('Choose a department first'); return; }
    // Snapshot pendingFiles up front, before any await runs.
    const pending = [...(state.conceptDrawer.pendingFiles || [])];
    try {
      // A single multipart request creates the concept AND uploads its
      // photos atomically - one request, one response, no separate
      // "create, then upload" step that could land the code but not the
      // photos depending on timing.
      const formData = new FormData();
      formData.append('department', department);
      formData.append('concept_no', document.getElementById('cf-concept_no').value);
      formData.append('description', document.getElementById('cf-description').value);
      ['source','concept_date','cost_estimate','factory','shipping_date','size_range_id',
       'fabric_code','composition','weight','buyer_rand_target','buyer_rsp_target','factory_target_price','factory_price','factory_cost_options', ...CONCEPT_DETAIL_FIELDS.map(f=>f.key)].forEach(f => {
        const el = document.getElementById('cf-'+f);
        if (el) formData.append(f, el.value);
      });
      formData.append('spec_category_id', state.conceptDrawer.specCategoryId || '');
      pending.forEach(entry => formData.append('photos', entry.file));

      const res = await fetch('/api/concepts', { method:'POST', body: formData });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data.error || 'Could not create concept');

      pending.forEach(entry => URL.revokeObjectURL(entry.url));
      const photos = data.photos || [];
      if (data.photoError) {
        toast(`${data.concept.concept_no} created, but ${data.photoError}`);
      } else {
        toast(`${data.concept.concept_no} created${pending.length ? ` with ${photos.length} photo${photos.length===1?'':'s'}` : ''}`);
      }
      closeConceptDrawer();
      await loadConcepts();
      autoGenerateCadOnCreate(data.concept.id, data.concept.concept_no, photos);
    } catch(e) { toast(e.message); }
    return;
  }

  try {
    const body = {
      spec_category_id: state.conceptDrawer.specCategoryId,
    };
    ['department','concept_no','description','source','concept_date','cost_estimate','factory','shipping_date','size_range_id',
     'fabric_code','fabric_prefix','composition','weight','buyer_rand_target','buyer_rsp_target','factory_target_price','factory_price','factory_cost_options', ...CONCEPT_DETAIL_FIELDS.map(f=>f.key)].forEach(f => {
      const el = document.getElementById('cf-'+f);
      if (el) body[f] = el.value;
    });
    // Extra fabric slots for a multi-piece set (see "+ Add Fabric") - read
    // straight from the DOM like every other field above, not from state,
    // since edits there only land in state.conceptDrawer.extraFabrics on a
    // fabric pick or an add/remove, and Save can be clicked before that.
    body.fabrics = (state.conceptDrawer.extraFabrics||[]).map((ef, i) => {
      const prefixEl = document.getElementById('ef-prefix-'+i);
      const fabricEl = document.getElementById('ef-fabric-'+i);
      const compEl = document.getElementById('ef-composition-'+i);
      const weightEl = document.getElementById('ef-weight-'+i);
      return {
        prefix: prefixEl ? prefixEl.value : (ef.prefix||''),
        fabric_code: fabricEl ? fabricEl.value : (ef.fabric_code||''),
        composition: compEl ? compEl.value : (ef.composition||''),
        weight: weightEl ? weightEl.value : (ef.weight||''),
      };
    });
    await api('/api/concepts/'+c.id, { method:'PUT', body: JSON.stringify(body) });
    toast('Saved');
    closeConceptDrawer();
    await loadConcepts();
  } catch(e) { toast(e.message); }
}

// Fires CAD generation automatically right after a new concept is created,
// using its first two reference photos - removes the need for a separate
// manual "Generate with AI" click immediately after creating. Silently does
// nothing if there aren't two usable photos yet; the CAD tab's own Generate
// button still covers adding them later. If the drawer is still open on
// this same concept once generation finishes, its photos are refreshed so
// the CAD tab picks up the result without needing to be reopened.
function autoGenerateCadOnCreate(conceptId, conceptNo, photos){
  const sourcePhotos = (photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (sourcePhotos.length < 2) return;
  const photoIds = [sourcePhotos[0].id, sourcePhotos[1].id];

  toast(`Generating CAD for ${conceptNo} in the background`);
  api('/api/concepts/'+conceptId+'/generate-cad-ai', { method:'POST', body: JSON.stringify({ photoIds }) })
    .then(async () => {
      await loadConcepts();
      if (state.conceptDrawer && state.conceptDrawer.concept && state.conceptDrawer.concept.id === conceptId) {
        const { photos: freshPhotos } = await api('/api/concepts/'+conceptId);
        state.conceptDrawer.photos = freshPhotos;
        render();
      }
      toast(`${conceptNo}'s CAD is ready`);
    })
    .catch(e => {
      toast(`CAD generation failed for ${conceptNo}: ` + e.message);
    });
}

// Saves the Details tab fields, then fires background AI CAD generation
// using the first two non-CAD photos as front/back - same "first two"
// convention generateOrRegenerateCad() uses on the CAD tab itself. Closes
// the drawer immediately since generation takes a while; the board tag
// shows ready once it's done. The CAD tab's own "Generate/Regenerate" and
// manual "Upload / override" both still work afterward to redo the result.
async function saveAndGenerateCad(){
  const { concept: c, photos } = state.conceptDrawer;
  const referencePhotos = (photos || []).filter(p => p.role !== 'cad' && p.role !== 'cad_detail');
  if (referencePhotos.length < 2) { toast('Add at least two reference photos before generating a CAD'); return; }
  const photoIds = [referencePhotos[0].id, referencePhotos[1].id];

  const body = {
    spec_category_id: state.conceptDrawer.specCategoryId,
  };
  ['description','source','concept_date','cost_estimate','factory','shipping_date','size_range_id',
   'fabric_code','composition','weight','buyer_rand_target','buyer_rsp_target','factory_target_price','factory_price','factory_cost_options', ...CONCEPT_DETAIL_FIELDS.map(f=>f.key)].forEach(f => {
    const el = document.getElementById('cf-'+f);
    if (el) body[f] = el.value;
  });

  const conceptId = c.id;
  const conceptNo = c.concept_no;

  try {
    await api('/api/concepts/'+conceptId, { method:'PUT', body: JSON.stringify(body) });
  } catch(e) { toast(e.message); return; }

  closeConceptDrawer();
  toast(`Saved. Generating CAD for ${conceptNo} in the background — carry on working, it'll show as ready on its tag`);

  api('/api/concepts/'+conceptId+'/generate-cad-ai', { method:'POST', body: JSON.stringify({ photoIds }) })
    .then(async () => {
      await loadConcepts();
      toast(`${conceptNo}'s CAD is ready`);
    })
    .catch(e => {
      toast(`CAD generation failed for ${conceptNo}: ` + e.message);
    });
}

async function deleteConcept(id, no){
  if (!confirm(`Permanently delete ${no}? This removes its photos too, and can't be undone.`)) return;
  try {
    await api('/api/concepts/'+id, { method:'DELETE' });
    state.concepts = state.concepts.filter(x=>x.id!==id);
    closeConceptDrawer();
    toast(`${no} deleted`);
  } catch(e) { toast(e.message); }
}

async function uploadConceptPhotos(conceptId){
  const input = document.getElementById('concept-photo-input');
  const files = input.files;
  if (!files || !files.length) return;
  const formData = new FormData();
  for (let i=0;i<files.length;i++) formData.append('photos', files[i]);
  try {
    const res = await fetch('/api/concepts/'+conceptId+'/photos', { method:'POST', body: formData });
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.conceptDrawer.photos = data.photos;
    render();
    toast(`${files.length} photo${files.length===1?'':'s'} added`);
  } catch(e) { toast(e.message); }
}

async function removeConceptPhoto(conceptId, photoId){
  if (!confirm('Remove this photo?')) return;
  try {
    const { photos } = await api('/api/concepts/'+conceptId+'/photos/'+photoId, { method:'DELETE' });
    state.conceptDrawer.photos = photos;
    render();
    toast('Photo removed');
  } catch(e) { toast(e.message); }
}

// Deletes the generated CAD photo specifically - also refreshes the board
// list so the "CAD" tag disappears from this concept's card right away.
async function deleteCadPhoto(conceptId, photoId){
  if (!confirm('Delete the generated CAD image? You can always generate a new one.')) return;
  try {
    const { photos } = await api('/api/concepts/'+conceptId+'/photos/'+photoId, { method:'DELETE' });
    state.conceptDrawer.photos = photos;
    state.conceptDrawer.cadPreview = null;
    render();
    await loadConcepts();
    toast('CAD image deleted');
  } catch(e) { toast(e.message); }
}

// Opens the existing New Style drawer, pre-filled from this concept - every
// field the Style drawer's Details tab shares with Concepts' own Details tab
// gets mapped across (see CONCEPT_TO_STYLE_FIELDS in drawer.js), not just
// department/description. On save, drawer.js's saveStyle() logs the
// conversion back here and copies the concept's photos onto the new style.
function convertConceptToStyle(conceptId){
  const c = state.conceptDrawer.concept;
  closeConceptDrawer();
  openNewStyle({ department: c.department, conceptId: c.id, conceptNo: c.concept_no, fromConcept: c });
}

// Shares the concept's first 2 reference photos (excludes the generated
// CAD - that's a separate, already-composited front+back image, not one of
// the raw references) straight to WhatsApp with the concept code as the
// message text. Uses the Web Share API (navigator.share with real File
// objects) where the browser supports sharing files - the only way to get
// actual attachments into WhatsApp from a web app, since wa.me links only
// support prefilled text, never media. Where that's not supported (most
// desktop browsers), falls back to downloading the photos and opening a
// WhatsApp Web chat prefilled with the concept code to paste them into.
async function shareConceptWhatsApp(){
  const { concept: c, photos } = state.conceptDrawer;
  const refPhotos = (photos||[]).filter(p => p.role !== 'cad' && p.role !== 'cad_detail').slice(0, 2);
  if (!refPhotos.length) { toast('No photos to share yet'); return; }

  let files = [];
  try {
    files = await Promise.all(refPhotos.map(async (p, i) => {
      const res = await fetch(p.path);
      const blob = await res.blob();
      const ext = (p.path.split('.').pop() || 'jpg').split('?')[0];
      return new File([blob], `${c.concept_no}-${i+1}.${ext}`, { type: blob.type || 'image/jpeg' });
    }));
  } catch(e) {
    toast('Could not load photos: ' + e.message);
    return;
  }

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, text: c.concept_no });
    } catch(e) {
      if (e.name !== 'AbortError') toast('Could not share: ' + e.message);
    }
    return;
  }

  refPhotos.forEach((p, i) => {
    const a = document.createElement('a');
    a.href = p.path;
    a.download = `${c.concept_no}-${i+1}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
  window.open(`https://wa.me/?text=${encodeURIComponent(c.concept_no)}`, '_blank');
  toast('Photos downloaded - attach them in the WhatsApp chat that just opened');
}