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

async function loadStyles(){ const { styles } = await api('/api/styles'); state.styles = styles; render(); }

function renderDashboard(){
  const canCreate = state.user.role !== 'buyer';
  if (!state.retailerFilter) state.retailerFilter = 'All';
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
    <div class="board">
      ${STAGES.map(st=>renderColumn(st, filtered)).join('')}
    </div>`;
}

function setRetailerFilter(value){ state.retailerFilter = value; render(); }

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
