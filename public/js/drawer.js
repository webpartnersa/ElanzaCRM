// ---- Style drawer: view/edit a single style across tabs, with Save ----
function blankStyleDraft(){
  return { id:null, style_no:'', retailer:RETAILERS[0], department:'Ladies', buyer:'', description:'',
    stage:'brief', season:'', units:'', target_rsp:'', raw_brief:'',
    fabric:'', colour:'', wash:'', topstitch:'', trims:'', styling:'', spec_notes:'', shipment_note:'', target_cost:'',
    cost:'', margin:'', factory:'', first_ship:'', first_delivery:'' };
}

async function openStyle(id){
  const { style, comments, photos } = await api('/api/styles/'+id);
  state.drawer = { style, comments, photos, isNew:false, tab:'brief', lightbox:null, floatPhotoIndex:0 };
  renderDrawerOnly();
}

function openNewStyle(prefill){
  const style = blankStyleDraft();
  let fromConceptId = null;
  let fromConceptNo = null;
  if (prefill) {
    if (prefill.department) style.department = prefill.department;
    if (prefill.description) style.description = prefill.description;
    fromConceptId = prefill.conceptId || null;
    fromConceptNo = prefill.conceptNo || null;
  }
  state.drawer = { style, comments: [], photos: [], isNew:true, tab:'brief', lightbox:null, floatPhotoIndex:0, fromConceptId, fromConceptNo };
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
  const { style: s, comments, photos, isNew, tab } = state.drawer;
  const canEdit = state.user.role !== 'buyer';
  const hasCad = !isNew && (photos||[]).some(p=>p.role==='cad');
  const tabs = [['brief','Buyer Brief'],['spec','Tech Spec'],['costing','Worksheet'],
    ...(!isNew ? [['cad', 'CAD'+(hasCad?' ✓':'')]] : []),
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
      ${renderSpecTab(s, canEdit)}
      ${renderCostingTab(s, canEdit)}
      ${isNew ? '' : renderStyleCadTab(s, photos, canEdit)}
      ${renderDocTab(s)}
      ${renderCommentsTab(s, comments)}
    </div>
<footer class="drawer-actions">
      ${canEdit && !isNew ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteStyle(${s.id}, '${s.style_no}')">Delete</button>` : ''}
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

function renderBriefTab(s, isNew, canEdit){
  const deptOptions = DEPARTMENTS.map(d=>`<option value="${d}" ${s.department===d?'selected':''}>${d}</option>`).join('');
  const retailerOptions = RETAILERS.map(r=>`<option value="${r}" ${s.retailer===r?'selected':''}>${r}</option>`).join('');
  return `<div class="${tabClass('brief')}" data-tab="brief">
    ${(!isNew && s.concept_ref) ? `<div class="field"><label>Converted from concept</label><input value="${s.concept_ref}" disabled/></div>` : ''}
    ${isNew ? `
      <div class="row2">
        <div class="field"><label>Retailer</label><select id="f-retailer" onchange="onStyleRetailerOrDeptChange()">${retailerOptions}</select></div>
        <div class="field"><label>Department</label><select id="f-department" onchange="onStyleRetailerOrDeptChange()">${deptOptions}</select></div>
      </div>
      <div class="field"><label>Style number (leave blank to auto-generate)</label><input id="f-style-no" placeholder="auto"/></div>
    ` : `
      <div class="field"><label>Pipeline stage</label>
        <select id="f-stage" ${canEdit?'':'disabled'}>
          ${STAGES.map(st=>`<option value="${st.id}" ${st.id===s.stage?'selected':''}>${st.label}</option>`).join('')}
        </select>
      </div>
    `}
    ${renderBuyerField(s, isNew, canEdit)}
    ${fld('Season', 'f-season', s.season, !canEdit)}
    ${taFld('Description', 'f-description', s.description, !canEdit)}
    <div class="row2">
      ${fld('Units', 'f-units', s.units, !canEdit)}
      ${fld('Target RSP (R)', 'f-target_rsp', s.target_rsp, !canEdit)}
    </div>
    ${taFld('Buyer brief notes', 'f-raw_brief', s.raw_brief, !canEdit)}
  </div>`;
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

function renderSpecTab(s, canEdit){
  return `<div class="${tabClass('spec')}" data-tab="spec">
    <div class="row2">
      ${fld('Fabric', 'f-fabric', s.fabric, !canEdit)}
      ${fld('Colour', 'f-colour', s.colour, !canEdit)}
    </div>
    <div class="row2">
      ${fld('Wash', 'f-wash', s.wash, !canEdit)}
      ${fld('Topstitch', 'f-topstitch', s.topstitch, !canEdit)}
    </div>
    ${fld('Trims', 'f-trims', s.trims, !canEdit)}
    ${taFld('Styling details', 'f-styling', s.styling, !canEdit)}
    ${taFld('Spec notes', 'f-spec_notes', s.spec_notes, !canEdit)}
    ${fld('Target cost (R)', 'f-target_cost', s.target_cost, !canEdit)}
  </div>`;
}

function renderCostingTab(s, canEdit){
  const isBuyer = state.user.role === 'buyer';
  if (isBuyer) {
    return `<div class="${tabClass('costing')}" data-tab="costing"><p style="color:var(--ink-soft);font-size:13px;">Costing details aren't shared with buyer accounts.</p></div>`;
  }
  return `<div class="${tabClass('costing')}" data-tab="costing">
    <div class="row2">
      ${fld('Cost (R)', 'f-cost', s.cost, !canEdit)}
      ${fld('Margin', 'f-margin', s.margin, !canEdit)}
    </div>
    ${fld('Factory', 'f-factory', s.factory, !canEdit)}
    <div class="row2">
      ${fld('First ship', 'f-first_ship', s.first_ship, !canEdit)}
      ${fld('First delivery', 'f-first_delivery', s.first_delivery, !canEdit)}
    </div>
    ${taFld('Shipment note', 'f-shipment_note', s.shipment_note || 'Please advise your best and safest shipment date', !canEdit)}
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

function generateOrRegenerateStyleCad(){
  const { style: s, photos } = state.drawer;
  const sourcePhotos = (photos || []).filter(p => p.role !== 'cad');
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

function generateDiscussionDoc(s){
  return [
    `STYLE DISCUSSION DOCUMENT`,
    `Style No: ${s.style_no || '(new - not yet saved)'}`,
    ...(s.concept_ref ? [`Concept ref: ${s.concept_ref}`] : []),
    `Retailer: ${s.retailer||''} — ${s.department||''}`,
    `Buyer: ${s.buyer||''}    Season: ${s.season||''}`,
    ``,
    `DESCRIPTION`,
    s.description || '(none)',
    ``,
    `TECH SPEC`,
    `Fabric: ${s.fabric||'-'}`,
    `Colour: ${s.colour||'-'}    Wash: ${s.wash||'-'}    Topstitch: ${s.topstitch||'-'}`,
    `Trims: ${s.trims||'-'}`,
    `Styling: ${s.styling||'-'}`,
    `Spec notes: ${s.spec_notes||'-'}`,
    ``,
    `COMMERCIALS`,
    `Units: ${s.units||'-'}    Target RSP: R${s.target_rsp||'-'}    Target cost: R${s.target_cost||'-'}`,
    ``,
    `SHIPMENT`,
    s.shipment_note || 'Please advise your best and safest shipment date',
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

const EDITABLE_FIELDS = [
  'buyer','season','description','units','target_rsp','raw_brief',
  'fabric','colour','wash','topstitch','trims','styling','spec_notes','target_cost',
  'cost','margin','factory','first_ship','first_delivery','shipment_note','cad_description'
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
