// ---- Spec category tree: per-department hierarchy (e.g. Ladies -> Denim ->
// Skinny) that feeds the cascading "Spec" picker in the Concept drawer. What
// actually constitutes the spec at a leaf isn't decided yet - this only
// builds and manages the picker's category structure. Loaded alongside
// concepts (see loadConcepts() in concepts.js), management UI lives in its
// own drawer opened from the Concepts topbar. ----

async function loadSpecCategories(){
  const { categories } = await api('/api/spec-categories');
  state.specCategories = categories;
  render();
}

function openSpecManager(){
  state.specManager = { retailer: RETAILERS[0], department: (state.conceptDrawer && state.conceptDrawer.concept.department) || DEPARTMENTS[0], pomBankCategoryId: null, poms: null };
  render();
}
function closeSpecManager(){ state.specManager = null; render(); }
function setSpecManagerDept(d){ state.specManager.department = d; render(); }
function setSpecManagerRetailer(r){ state.specManager.retailer = r; render(); }

// Recursive - depth just controls indent. Each node gets add-child/rename/
// delete inline, via prompt()/confirm() (same lightweight pattern already
// used elsewhere in this app, e.g. deleteFabric) rather than a nested form.
// Leaf nodes (nothing nested under them) also get a "Measurements" button -
// only a leaf can carry a POM bank, since that's the level a style actually
// picks (see spec_category_poms in db.js).
function renderSpecTree(nodes, parentId, depth){
  const children = nodes.filter(n => n.parent_id === parentId).sort((a,b)=> (a.sort_order-b.sort_order) || a.name.localeCompare(b.name));
  if (!children.length) return '';
  return `<ul class="spec-tree" style="margin-left:${depth?18:0}px;">
    ${children.map(n => {
      const isLeaf = !nodes.some(x => x.parent_id === n.id);
      return `
      <li>
        <div class="spec-tree-row">
          <span>${n.name}</span>
          <span class="spec-tree-actions">
            ${isLeaf ? `<button class="btn btn-ghost btn-sm" onclick="openPomBank(${n.id})">Measurements</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="addSpecCategoryChild(${n.id})">+ Add child</button>
            <button class="btn btn-ghost btn-sm" onclick="renameSpecCategory(${n.id})">Rename</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteSpecCategory(${n.id})">Delete</button>
          </span>
        </div>
        ${renderSpecTree(nodes, n.id, depth+1)}
      </li>
    `;}).join('')}
  </ul>`;
}

function renderSpecManagerHost(){
  const m = state.specManager;
  if (!m) return `<div class="overlay" onclick="closeSpecManager()"></div><div class="drawer"></div>`;
  if (m.pomBankCategoryId) {
    return `<div class="overlay open" onclick="closeSpecManager()"></div><div class="drawer open">${renderPomBankHost()}</div>`;
  }
  const nodes = (state.specCategories||[]).filter(n => n.department === m.department && n.retailer === m.retailer);
  return `
    <div class="overlay open" onclick="closeSpecManager()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>Manage Spec Hierarchy</h2>
        <button class="drawer-close" onclick="closeSpecManager()">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="row2">
          <div class="field">
            <label>Retailer</label>
            <select onchange="setSpecManagerRetailer(this.value)">
              ${RETAILERS.map(r=>`<option value="${r}" ${m.retailer===r?'selected':''}>${r}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Department</label>
            <select onchange="setSpecManagerDept(this.value)">
              ${DEPARTMENTS.map(d=>`<option value="${d}" ${m.department===d?'selected':''}>${d}</option>`).join('')}
            </select>
          </div>
        </div>
        ${nodes.length ? renderSpecTree(nodes, null, 0) : `<div class="hint">No spec categories yet for ${m.retailer} / ${m.department}.</div>`}
        <button class="btn btn-ghost btn-sm" style="margin-top:12px;" onclick="addSpecRootCategory('${m.retailer}','${m.department}')">+ Add top-level category</button>
      </div>
    </div>`;
}

// ---- POM bank: the reference measurement list for one leaf category (see
// spec_category_poms in db.js) - a sub-view of the same Manage Spec
// Hierarchy drawer, not a separate one, same "swap the body, don't stack
// drawers" pattern as Fabrics' codes-list/reports-list subviews. ----

function openPomBank(categoryId){
  state.specManager.pomBankCategoryId = categoryId;
  state.specManager.poms = null;
  render();
  api('/api/spec-categories/'+categoryId+'/poms').then(({poms}) => {
    if (state.specManager && state.specManager.pomBankCategoryId === categoryId) {
      state.specManager.poms = poms;
      render();
    }
  }).catch(e => toast(e.message));
}
function closePomBank(){
  state.specManager.pomBankCategoryId = null;
  state.specManager.poms = null;
  render();
}
async function reloadPomBank(){
  const { poms } = await api('/api/spec-categories/'+state.specManager.pomBankCategoryId+'/poms');
  state.specManager.poms = poms;
  render();
}
function addPomBankRow(){
  const nameEl = document.getElementById('pom-new-name');
  const specEl = document.getElementById('pom-new-spec');
  const name = nameEl.value.trim();
  if (!name) { toast('Enter a point of measure name'); return; }
  api('/api/spec-categories/'+state.specManager.pomBankCategoryId+'/poms', { method:'POST', body: JSON.stringify({ name, spec_to_be: specEl.value.trim() }) })
    .then(reloadPomBank)
    .catch(e => toast(e.message));
}
function updatePomBankField(pomId, field, value){
  api('/api/spec-categories/poms/'+pomId, { method:'PUT', body: JSON.stringify({ [field]: value }) })
    .catch(e => toast(e.message));
}
function deletePomBankRow(pomId){
  const pom = (state.specManager.poms||[]).find(p=>p.id===pomId);
  if (!pom) return;
  if (!confirm(`Remove "${pom.name}" from this bank? Styles that already copied it keep their own copy - this only affects styles that pick this category from now on.`)) return;
  api('/api/spec-categories/poms/'+pomId, { method:'DELETE' })
    .then(reloadPomBank)
    .catch(e => toast(e.message));
}
// Swaps sort_order with the adjacent row rather than a dedicated reorder
// endpoint - same approach the backend comment documents.
function movePomBankRow(pomId, direction){
  const poms = (state.specManager.poms||[]).slice().sort((a,b)=>a.sort_order-b.sort_order);
  const idx = poms.findIndex(p=>p.id===pomId);
  const swapIdx = idx + direction;
  if (idx < 0 || swapIdx < 0 || swapIdx >= poms.length) return;
  const a = poms[idx], b = poms[swapIdx];
  Promise.all([
    api('/api/spec-categories/poms/'+a.id, { method:'PUT', body: JSON.stringify({ sort_order: b.sort_order }) }),
    api('/api/spec-categories/poms/'+b.id, { method:'PUT', body: JSON.stringify({ sort_order: a.sort_order }) }),
  ]).then(reloadPomBank).catch(e => toast(e.message));
}

function renderPomBankHost(){
  const m = state.specManager;
  const category = (state.specCategories||[]).find(n=>n.id===m.pomBankCategoryId);
  const poms = (m.poms||[]).slice().sort((a,b)=>a.sort_order-b.sort_order);
  return `
    <div class="drawer-head">
      <h2>Measurements: ${category ? category.name : ''}</h2>
      <button class="drawer-close" onclick="closeSpecManager()">&times;</button>
    </div>
    <div class="drawer-body">
      <button class="btn btn-ghost btn-sm" onclick="closePomBank()">← Back to hierarchy</button>
      <div class="hint" style="margin-top:8px;">Every point of measure a style using "${category?category.name:''}" as its spec starts out with, and its target ("spec to be") value - this is what gets copied onto a style's own measurement sheet the moment it picks this category.</div>
      ${m.poms === null ? `<div class="hint" style="margin-top:12px;">Loading...</div>` : (poms.length ? `
        <div class="contacts-wrap" style="margin-top:14px;">
          <table class="contacts-table">
            <thead><tr><th>Point of measure</th><th style="width:120px;">Spec to be</th><th></th></tr></thead>
            <tbody>
              ${poms.map((p, i) => `
                <tr>
                  <td><input value="${(p.name||'').replace(/"/g,'&quot;')}" onchange="updatePomBankField(${p.id},'name',this.value)"/></td>
                  <td><input value="${(p.spec_to_be||'').replace(/"/g,'&quot;')}" onchange="updatePomBankField(${p.id},'spec_to_be',this.value)"/></td>
                  <td style="white-space:nowrap;text-align:right;">
                    <button class="btn btn-ghost btn-sm" ${i===0?'disabled':''} onclick="movePomBankRow(${p.id},-1)">↑</button>
                    <button class="btn btn-ghost btn-sm" ${i===poms.length-1?'disabled':''} onclick="movePomBankRow(${p.id},1)">↓</button>
                    <button class="btn btn-ghost btn-sm" onclick="deletePomBankRow(${p.id})">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<div class="empty-state" style="margin-top:12px;">No points of measure added yet.</div>`)}
      <div class="row2" style="margin-top:16px;">
        <div class="field"><label>New point of measure</label><input id="pom-new-name" placeholder="e.g. 1/2 WAIST RELAXED"/></div>
        <div class="field"><label>Spec to be</label><input id="pom-new-spec" placeholder="e.g. 35"/></div>
      </div>
      <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="addPomBankRow()">+ Add point of measure</button>
    </div>`;
}

function addSpecRootCategory(retailer, department){
  const name = prompt(`New top-level category under ${retailer} / ${department}:`);
  if (!name || !name.trim()) return;
  api('/api/spec-categories', { method:'POST', body: JSON.stringify({ retailer, department, name: name.trim() }) })
    .then(loadSpecCategories)
    .catch(e => toast(e.message));
}
function addSpecCategoryChild(parentId){
  const name = prompt('New sub-category name:');
  if (!name || !name.trim()) return;
  api('/api/spec-categories', { method:'POST', body: JSON.stringify({ parent_id: parentId, name: name.trim() }) })
    .then(loadSpecCategories)
    .catch(e => toast(e.message));
}
function renameSpecCategory(id){
  const node = (state.specCategories||[]).find(n=>n.id===id);
  if (!node) return;
  const name = prompt('Rename category:', node.name);
  if (!name || !name.trim() || name.trim() === node.name) return;
  api('/api/spec-categories/'+id, { method:'PUT', body: JSON.stringify({ name: name.trim() }) })
    .then(loadSpecCategories)
    .catch(e => toast(e.message));
}
function deleteSpecCategory(id){
  const node = (state.specCategories||[]).find(n=>n.id===id);
  if (!node) return;
  if (!confirm(`Delete "${node.name}" and everything under it? This can't be undone, and any concept using it will have its spec cleared.`)) return;
  api('/api/spec-categories/'+id, { method:'DELETE' })
    .then(async () => { await loadSpecCategories(); await loadConcepts(); })
    .catch(e => toast(e.message));
}

// Builds the SPEC picker as a chain of <select>s - one per tree level,
// populated with the children of whatever was picked one level up, stopping
// once a leaf (no children) is reached. `selectedId` is the deepest node
// currently chosen (state.conceptDrawer.specCategoryId); onSpecLevelChange
// truncates/extends that chain as the user picks through it.
//
// A concept doesn't know its retailer yet (that's only fixed once it
// becomes a style - see the Style drawer's own separate spec picker in
// drawer.js, which does filter by retailer), so this deliberately shows
// every retailer's categories for the department together. Root-level
// options are labeled with their retailer so, now that the hierarchy is
// split per retailer, two retailers both having e.g. "Denim" doesn't read
// as one ambiguous duplicate entry.
function renderSpecSelector(department, selectedId){
  const nodes = (state.specCategories||[]).filter(n => n.department === department);
  if (!nodes.length) return `<div class="hint">No spec categories set up yet for ${department} - <a href="javascript:void(0)" onclick="openSpecManager()">manage spec hierarchy</a>.</div>`;

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
    const options = nodes.filter(n => n.parent_id === parentId).sort((a,b)=> (a.sort_order-b.sort_order) || a.name.localeCompare(b.name));
    if (!options.length) break;
    const chosen = chain[level] || '';
    selects.push(`
      <select onchange="onSpecLevelChange(${level}, this.value)">
        <option value="">Select...</option>
        ${options.map(o=>`<option value="${o.id}" ${String(chosen)===String(o.id)?'selected':''}>${o.name}${level===0?' ('+o.retailer+')':''}</option>`).join('')}
      </select>
    `);
    if (!chosen) break;
    parentId = Number(chosen);
    level++;
  }
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;">${selects.join('')}</div>
    <div class="hint" style="margin-top:4px;">Choose down to the most specific level available - <a href="javascript:void(0)" onclick="openSpecManager()">manage spec hierarchy</a>.</div>`;
}

// Rebuilds the chosen chain up to (not including) `level`, then appends the
// newly picked value - picking a different option at any level invalidates
// everything deeper than it, same as any cascading dropdown.
function onSpecLevelChange(level, value){
  syncConceptDraftFromDom();
  const d = state.conceptDrawer;
  const nodes = state.specCategories || [];
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  let chain = [];
  if (d.specCategoryId && byId[d.specCategoryId]) {
    let cur = byId[d.specCategoryId];
    chain.unshift(cur.id);
    while (cur.parent_id) { cur = byId[cur.parent_id]; if (!cur) break; chain.unshift(cur.id); }
  }
  chain = chain.slice(0, level);
  if (value) chain.push(Number(value));
  d.specCategoryId = chain.length ? chain[chain.length-1] : null;
  patchConceptDrawerBody();
}
