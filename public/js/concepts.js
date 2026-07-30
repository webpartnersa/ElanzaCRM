// ---- Concepts: sample/photo gallery, searchable by department + keyword ----
function initConceptsState(){
  if (!state.concepts) state.concepts = [];
  if (state.departmentFilterConcepts === undefined) state.departmentFilterConcepts = 'All';
  if (state.conceptSearch === undefined) state.conceptSearch = '';
}

async function loadConcepts(){
  initConceptsState();
  const { concepts } = await api('/api/concepts');
  state.concepts = concepts;
  render();
}

function renderConceptsView(){
  initConceptsState();
  const canCreate = state.user.role !== 'buyer';
  const q = state.conceptSearch.trim().toLowerCase();
  const filtered = state.concepts.filter(c=>{
    if (state.departmentFilterConcepts !== 'All' && c.department !== state.departmentFilterConcepts) return false;
    if (q) {
      const hay = ((c.description||'') + ' ' + (c.tags||'')).toLowerCase();
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
        <input id="concept-search" placeholder="Search description or tags..." value="${state.conceptSearch}" oninput="setConceptSearch(this.value)" style="width:220px;"/>
        ${canCreate ? `<button class="btn btn-primary" onclick="openNewConcept()">+ New Concept</button>` : ''}
      </div>
    </div>
    <div class="concept-grid">
      ${filtered.map(renderConceptCard).join('') || '<div class="empty-state">No concepts yet.</div>'}
    </div>
    ${renderConceptDrawerHost()}
  `;
}

function renderConceptCard(c){
  return `
    <div class="concept-card" onclick="openConcept(${c.id})">
      ${c.cover_photo ? `<img class="concept-thumb" src="${c.cover_photo}"/>` : `<div class="concept-thumb concept-thumb-empty">No photo</div>`}
      ${c.has_cad ? `<span class="cad-badge">CAD</span>` : ''}
      <div class="concept-card-body">
        <div class="concept-no mono">${c.concept_no}${c.favourite ? ' \u2605' : ''}</div>
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
  return { id:null, department:DEPARTMENTS[0], description:'', source:'', tags:'', concept_date: new Date().toISOString().slice(0,7), cost_estimate:'', factory:'', shipping_date:'', favourite:0 };
}

async function openConcept(id){
  const { concept, photos, conversions } = await api('/api/concepts/'+id);
  state.conceptDrawer = { concept, photos, conversions, isNew:false, lightboxIndex:null, tab:'details' };
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
  state.conceptDrawer = { concept: blankConceptDraft(), photos: [], conversions: [], isNew:true, pendingFiles:[], lightboxIndex:null, tab:'details' };
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
    <div class="drawer ${open?'open':''}">
      ${open ? renderConceptDrawerContent() : ''}
    </div>
    ${(lightboxIndex!=null && photos[lightboxIndex]) ? renderConceptLightbox(photos, lightboxIndex) : ''}
  `;
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

function renderConceptDrawerContent(){
  const { concept: c, photos, conversions, isNew, tab, pendingFiles } = state.conceptDrawer;
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
          <img class="photo-thumb" src="${p.path}" onclick="openConceptLightbox(${i})"/>
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
          <img class="photo-thumb" src="${p.url}"/>
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
        <select id="cf-department" ${canEdit?'':'disabled'}>${deptOptions}</select>
        ${!isNew ? `<div class="hint" style="margin-top:4px;">Changing this reassigns the concept code (currently ${c.concept_no}) to match the new department.</div>` : ''}
      </div>
      <div class="field"><label>Description</label><textarea id="cf-description" ${canEdit?'':'disabled'}>${c.description||''}</textarea></div>
      <div class="field"><label>Source</label>
        <select id="cf-source" ${canEdit?'':'disabled'}>
          <option value="" ${!c.source?'selected':''}>-</option>
          <option value="Buyer photo" ${c.source==='Buyer photo'?'selected':''}>Buyer photo</option>
          <option value="In-house sample" ${c.source==='In-house sample'?'selected':''}>In-house sample</option>
          <option value="Bought-in reference" ${c.source==='Bought-in reference'?'selected':''}>Bought-in reference</option>
        </select>
      </div>
      <div class="field"><label>Tags (comma separated)</label><input id="cf-tags" value="${c.tags||''}" ${canEdit?'':'disabled'}/></div>
      <div class="field"><label>Concept date</label><input type="month" id="cf-concept_date" value="${c.concept_date||''}" ${canEdit?'':'disabled'}/></div>
      ${canEdit ? `
        <div class="row2">
          <div class="field"><label>Cost estimate (R)</label><input id="cf-cost_estimate" value="${c.cost_estimate||''}"/></div>
          <div class="field"><label>Factory</label><input id="cf-factory" value="${c.factory||''}"/></div>
        </div>
        <div class="field"><label>Shipping Date</label><input type="date" id="cf-shipping_date" value="${c.shipping_date||''}"/></div>
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;margin-bottom:14px;">
          <input type="checkbox" id="cf-favourite" ${c.favourite?'checked':''}/> Favourite
        </label>
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

  return `
    <div class="drawer-head">
      <h2>${isNew ? 'New Concept' : c.concept_no}</h2>
      <button class="drawer-close" onclick="closeConceptDrawer()">&times;</button>
    </div>
    ${!isNew ? `
      <div class="tabs">
        <button class="tab ${currentTab==='details'?'active':''}" data-tab="details" onclick="setConceptDrawerTab('details')">Details</button>
        <button class="tab ${currentTab==='cad'?'active':''}" data-tab="cad" onclick="setConceptDrawerTab('cad')">CAD${hasCad?' \u2713':''}</button>
      </div>
    ` : ''}
    <div class="drawer-body">
      ${isNew ? detailsTabHtml : `
        <div class="tab-panel ${currentTab==='details'?'active':''}" data-tab="details">${detailsTabHtml}</div>
        <div class="tab-panel ${currentTab==='cad'?'active':''}" data-tab="cad">${cadTabHtml}</div>
      `}
    </div>
    <footer class="drawer-actions">
      ${(!isNew && canEdit) ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteConcept(${c.id}, '${c.concept_no}')">Delete</button>` : ''}
      ${(!isNew && canEdit) ? `<button class="btn btn-ghost" onclick="convertConceptToStyle(${c.id})">Convert to style</button>` : ''}
      ${canEdit ? `<button class="btn btn-primary" onclick="saveConcept()">${isNew ? 'Create concept' : 'Save changes'}</button>` : ''}
    </footer>`;
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
  const fields = ['department','description','source','tags','concept_date','cost_estimate','factory','shipping_date'];
  fields.forEach(f => {
    const el = document.getElementById('cf-'+f);
    if (el) d.concept[f] = el.value;
  });
  const favEl = document.getElementById('cf-favourite');
  if (favEl) d.concept.favourite = favEl.checked ? 1 : 0;
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
      formData.append('description', document.getElementById('cf-description').value);
      ['source','tags','concept_date','cost_estimate','factory','shipping_date'].forEach(f => {
        const el = document.getElementById('cf-'+f);
        if (el) formData.append(f, el.value);
      });
      const favEl = document.getElementById('cf-favourite');
      formData.append('favourite', (favEl && favEl.checked) ? '1' : '0');
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
      department: document.getElementById('cf-department') ? document.getElementById('cf-department').value : undefined,
      description: document.getElementById('cf-description') ? document.getElementById('cf-description').value : undefined,
      source: document.getElementById('cf-source') ? document.getElementById('cf-source').value : undefined,
      tags: document.getElementById('cf-tags') ? document.getElementById('cf-tags').value : undefined,
      concept_date: document.getElementById('cf-concept_date') ? document.getElementById('cf-concept_date').value : undefined,
      cost_estimate: document.getElementById('cf-cost_estimate') ? document.getElementById('cf-cost_estimate').value : undefined,
      factory: document.getElementById('cf-factory') ? document.getElementById('cf-factory').value : undefined,
      shipping_date: document.getElementById('cf-shipping_date') ? document.getElementById('cf-shipping_date').value : undefined,
      favourite: document.getElementById('cf-favourite') ? (document.getElementById('cf-favourite').checked ? 1 : 0) : undefined,
    };
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
    description: document.getElementById('cf-description') ? document.getElementById('cf-description').value : undefined,
    source: document.getElementById('cf-source') ? document.getElementById('cf-source').value : undefined,
    tags: document.getElementById('cf-tags') ? document.getElementById('cf-tags').value : undefined,
    concept_date: document.getElementById('cf-concept_date') ? document.getElementById('cf-concept_date').value : undefined,
    cost_estimate: document.getElementById('cf-cost_estimate') ? document.getElementById('cf-cost_estimate').value : undefined,
    factory: document.getElementById('cf-factory') ? document.getElementById('cf-factory').value : undefined,
    shipping_date: document.getElementById('cf-shipping_date') ? document.getElementById('cf-shipping_date').value : undefined,
    favourite: document.getElementById('cf-favourite') ? (document.getElementById('cf-favourite').checked ? 1 : 0) : undefined,
  };

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

// Opens the existing New Style drawer, pre-filled from this concept. On
// save, drawer.js's saveStyle() logs the conversion back here and copies
// the concept's photos onto the new style automatically.
function convertConceptToStyle(conceptId){
  const c = state.conceptDrawer.concept;
  closeConceptDrawer();
  openNewStyle({ department: c.department, description: c.description, conceptId: c.id, conceptNo: c.concept_no });
}