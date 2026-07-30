// ---- Fabrics: base fabric codes, each with a composition and a lab
// approval report that's only valid 12 months from its approval date.
// Feeds the fabric autofill in the order drawer (shipping.js) and the
// renewal-reminder check in the Notification Centre (notifications.js).

function initFabricsState(){
  if (!state.fabrics) state.fabrics = [];
  if (state.fabricDrawer === undefined) state.fabricDrawer = null;
}

async function loadFabrics(){
  initFabricsState();
  const { fabrics } = await api('/api/fabrics');
  state.fabrics = fabrics;
  render();
}

function fabricExpiry(approvalDate){
  const d = parseShipDate(approvalDate);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth() + 12, d.getDate());
}
// 30 days before expiry = "renewal required" - the reminder window asked for.
function fabricStatus(fabric){
  const expiry = fabricExpiry(fabric.approval_date);
  if (!expiry) return { label: 'No approval date', cls: 'fabric-status-none' };
  const daysLeft = Math.round((expiry - new Date()) / (1000*60*60*24));
  if (daysLeft < 0) return { label: `Expired ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-expired' };
  if (daysLeft <= 30) return { label: `Renew by ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-warn' };
  return { label: `Valid until ${formatShipDateShort(toLocalISODate(expiry))}`, cls: 'fabric-status-ok' };
}

function renderFabricsView(){
  initFabricsState();
  const rows = state.fabrics.slice().sort((a,b)=>a.code.localeCompare(b.code)).map(f => {
    const status = fabricStatus(f);
    return `
      <tr>
        <td class="name-cell mono">${f.code}</td>
        <td>${f.composition||''}</td>
        <td class="mono">${f.report_number||''}</td>
        <td>${f.approval_date ? formatShipDateShort(f.approval_date) : ''}</td>
        <td><span class="fabric-status ${status.cls}">${status.label}</span></td>
        <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="openEditFabric(${f.id})">Edit</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="6"><div class="empty-state">No fabrics added yet.</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Fabrics</h1><p>${state.fabrics.length} fabric${state.fabrics.length===1?'':'s'}</p></div>
      <div class="row-actions">
        <button class="btn btn-primary" onclick="openNewFabric()">+ New Fabric</button>
      </div>
    </div>
    <div class="hint" style="margin-top:8px;">Lab approval reports are valid for 12 months from the approval date - Notifications flags anything due for renewal within 30 days.</div>
    <div class="contacts-wrap" style="margin-top:14px;">
      <table class="contacts-table">
        <thead>
          <tr><th>Fabric code</th><th>Composition</th><th>Approval report #</th><th>Approval date</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderFabricDrawerHost()}
  `;
}

function blankFabricDraft(){
  return { id:null, code:'', composition:'', report_number:'', approval_date:'' };
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
        <div class="field"><label>Approval report number</label><input id="fb-report_number" value="${f.report_number||''}" placeholder="e.g. NQA260113071"/></div>
        <div class="field">
          <label>Approval date</label>
          <input id="fb-approval_date" type="date" value="${f.approval_date||''}"/>
          <div class="hint" style="margin-top:4px;">${f.approval_date ? fabricStatus(f).label + ' (12 months from approval)' : 'Valid for 12 months from this date'}</div>
        </div>
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
    report_number: document.getElementById('fb-report_number').value.trim(),
    approval_date: document.getElementById('fb-approval_date').value,
  };
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
  if (!confirm('Remove this fabric?')) return;
  try {
    await api('/api/fabrics/'+id, { method:'DELETE' });
    state.fabrics = state.fabrics.filter(f=>f.id!==id);
    closeFabricDrawer();
    toast('Fabric removed');
  } catch(e) { toast(e.message); }
}
