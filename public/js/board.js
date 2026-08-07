// ---- Style pipeline board (columns by stage) ----
const STAGES = [
  { id:'brief', label:'Brief In' },
  { id:'doc_sent', label:'Doc Sent' },
  { id:'costed', label:'Costed' },
  { id:'worksheet', label:'Worksheet In' },
  { id:'proceed', label:'Proceed Sent' },
  { id:'po', label:'PO Confirmed' },
];
const DEPARTMENTS = ['Ladies','Mens','Younger Boys','Older Boys','Younger Girls','Older Girls','Babywear'];
const RETAILERS = ['PnP','Eagle','PEP'];
function stageLabel(id){ const s = STAGES.find(x=>x.id===id); return s ? s.label : id; }

// Factory dropdown source for the Style drawer (see renderStyleFactorySelect
// in drawer.js) - fetched alongside the board itself rather than lazily on
// drawer open, same reasoning as loadConcepts()' factoryNames fetch: a
// styles-only user (no 'concepts' permission) still needs this ready the
// moment they open a style. Shares state.factoryNames with concepts.js's own
// fetch - both read the same Contacts-backed list, so whichever loaded last
// just refreshes the same array, never a conflicting one.
async function loadStyles(){
  const canSeeFactory = state.user.role !== 'buyer';
  const [{ styles }, factoryResult] = await Promise.all([
    api('/api/styles'),
    canSeeFactory ? api('/api/styles/factory-names') : Promise.resolve(null),
  ]);
  state.styles = styles;
  if (factoryResult) state.factoryNames = factoryResult.factories;
  render();
}

function renderDashboard(){
  const canCreate = state.user.role !== 'buyer';
  if (!state.retailerFilter) state.retailerFilter = 'All';
  if (!state.styleBoardView) state.styleBoardView = 'columns';
  const filtered = state.retailerFilter === 'All' ? state.styles : state.styles.filter(s => s.retailer === state.retailerFilter);
  return `
    <div class="topbar">
      <div><h1 class="display">Style pipeline</h1><p>${filtered.length} style${filtered.length===1?'':'s'}</p></div>
      <div class="row-actions">
        ${state.user.role!=='buyer' ? `
          <select id="retailer-filter" onchange="setRetailerFilter(this.value)" style="width:auto;">
            <option value="All" ${state.retailerFilter==='All'?'selected':''}>All retailers</option>
            ${RETAILERS.map(r=>`<option value="${r}" ${state.retailerFilter===r?'selected':''}>${r}</option>`).join('')}
          </select>
        ` : ''}
        ${canCreate ? `<button class="btn btn-primary" onclick="openNewStyle()">+ New Style</button>` : ''}
      </div>
    </div>
    <a class="back-link" style="margin-bottom:14px;" onclick="setStyleBoardView('${state.styleBoardView==='columns'?'rows':'columns'}')">
      ${state.styleBoardView==='columns' ? 'Switch to rows view' : 'Switch to columns view'}
    </a>
    ${state.styleBoardView==='columns' ? renderBoardColumns(filtered) : renderBoardRows(filtered)}`;
}

function setRetailerFilter(value){ state.retailerFilter = value; render(); }
function setStyleBoardView(view){ state.styleBoardView = view; render(); }

function renderBoardColumns(styles){
  return `
    <div class="board">
      ${STAGES.map(st=>renderColumn(st, styles)).join('')}
    </div>`;
}

// ---- Rows view: a completely separate template from the columns/Kanban
// view above (renderColumn/renderTag) rather than a shared/parametrized
// one - expected to change independently and often, so keeping it
// structurally isolated avoids the two views fighting over one shape. ----
function renderBoardRows(styles){
  const sorted = styles.slice().sort((a,b) => (a.style_no||'').localeCompare(b.style_no||''));
  return `
    <div class="contacts-wrap">
      <table class="contacts-table">
        <thead>
          <tr>
            <th></th>
            <th>Style #</th>
            <th>Description</th>
            <th>Retailer</th>
            <th>Department</th>
            <th>Buyer</th>
            <th>Stage</th>
            <th>Target RSP</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(renderStyleRow).join('') || `<tr><td colspan="8"><div class="empty-state">No styles yet.</div></td></tr>`}
        </tbody>
      </table>
    </div>`;
}
function renderStyleRow(s){
  return `
    <tr onclick="openStyle(${s.id})" style="cursor:pointer;">
      <td>${s.cover_photo ? `<img src="${s.cover_photo}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;display:block;"/>` : ''}</td>
      <td class="name-cell mono">${s.style_no}</td>
      <td>${s.description||''}</td>
      <td>${s.retailer||''}</td>
      <td>${s.department||''}</td>
      <td>${s.buyer||''}</td>
      <td><span class="stage-tag">${stageLabel(s.stage)}</span></td>
      <td class="mono">${s.target_rsp ? 'R'+s.target_rsp : ''}</td>
    </tr>`;
}

function renderColumn(stage, styles){
  const colStyles = styles.filter(s => s.stage === stage.id);
  return `
    <div class="col">
<div class="col-head"><span class="label">${stage.label}</span><span class="count mono">${colStyles.length}</span></div>
      <div class="col-body">
        ${colStyles.map(renderTag).join('') || '<div class="empty-col">No styles here</div>'}
      </div>
    </div>`;
}

function renderTag(s){
  return `
    <div class="tag" onclick="openStyle(${s.id})">
      ${s.cover_photo ? `<img class="tag-photo" src="${s.cover_photo}" alt=""/>` : ''}
      <div class="styleno">${s.style_no}</div>
      <div class="desc">${s.description||''}</div>
      <div class="meta">
        <span class="rsp">${s.target_rsp ? 'R'+s.target_rsp : ''}</span>
      </div>
    </div>`;
}
