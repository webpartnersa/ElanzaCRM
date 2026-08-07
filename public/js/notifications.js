// ---- Notification Centre: mostly computed live from real data, not a
// stored/scheduled system - orders delayed multiple times and fabric
// reports due for renewal are both re-derived from current state each
// time. Fabric data inconsistencies are the exception: a real stored row
// (fabric_report_flags), since they describe a one-time event at upload
// time that can't be losslessly re-derived later.
//
// Read/unread is tracked separately (notification_reads table). For the
// two computed checks, each alert's key bakes in its current value
// (delay_count, a report's own report_date) - if that value changes
// later, the key changes too and it naturally reappears as unread, no
// separate "did this change since last read" logic needed. Inconsistency
// flags don't change after creation, so their key is just the flag's own
// id. ----
const DELAY_ALERT_THRESHOLD = 2; // delay_count >= 2 = on at least its 3rd shipment date

function initNotificationsState(){
  if (!state.notificationReadKeys) state.notificationReadKeys = new Set();
}
async function loadNotificationReads(){
  initNotificationsState();
  const { keys } = await api('/api/notifications/reads');
  state.notificationReadKeys = new Set(keys);
  render();
}
function isNotifRead(key){
  return state.notificationReadKeys ? state.notificationReadKeys.has(key) : false;
}
// Optimistic - marks locally first so the UI updates immediately, then
// persists. A failed save just means it reverts to unread on next reload,
// which is the safe direction to fail in (never silently loses an alert).
async function markNotificationsRead(keys){
  initNotificationsState();
  const newKeys = keys.filter(k => !state.notificationReadKeys.has(k));
  if (!newKeys.length) return;
  newKeys.forEach(k => state.notificationReadKeys.add(k));
  render();
  try {
    await api('/api/notifications/reads', { method:'POST', body: JSON.stringify({ keys: newKeys }) });
  } catch(e) { toast('Could not save read status: ' + e.message); }
}

function collectDelayAlerts(){
  if (!state.shipping) return [];
  return shippingGroups()
    .flatMap(g => g.orders.map(o => ({ order: o, group: g, key: `delay:${o.id}:${o.delay_count}` })))
    .filter(({order}) => (order.delay_count||0) >= DELAY_ALERT_THRESHOLD)
    .sort((a,b) => (b.order.delay_count||0) - (a.order.delay_count||0));
}

// Per REPORT, not per fabric - a fabric's own row only ever reflects its
// most recently uploaded report, so watching fabrics.approval_date alone
// missed any older-but-still-on-file report quietly creeping inside its
// own 30-day renewal window. Reuses fabricStatus/fabricExpiry from
// fabrics.js (same threshold as the Fabric Reports list's Status column)
// fed each report's own report_date instead of a fabric's approval_date.
function collectFabricAlerts(){
  if (!state.fabricReports) return [];
  return state.fabricReports
    .map(r => ({ report: r, status: fabricStatus({ approval_date: r.report_date }), key: `report:${r.id}:${r.report_date||'none'}` }))
    .filter(({status}) => status.cls==='fabric-status-warn' || status.cls==='fabric-status-expired')
    .sort((a,b) => {
      const da = fabricExpiry({ approval_date: a.report.report_date });
      const db = fabricExpiry({ approval_date: b.report.report_date });
      return (da?da.getTime():0) - (db?db.getTime():0);
    });
}

// Composition/weight mismatches flagged at report-upload time (see
// routes/fabrics.js's POST /test-reports) - unlike the other two checks
// this isn't re-derived from current state, it's a real stored row (the
// underlying fabric/report values that triggered it may since have moved
// on), so the key is just the flag's own id, not a value snapshot.
function collectInconsistencyAlerts(){
  if (!state.fabricReportFlags) return [];
  return state.fabricReportFlags.map(f => ({ flag: f, key: `fabricflag:${f.id}` }));
}

function collectUnreadNotificationCount(){
  const delayAlerts = hasPerm(state.user,'shipping') ? collectDelayAlerts() : [];
  const fabricAlerts = hasPerm(state.user,'fabrics') ? collectFabricAlerts() : [];
  const inconsistencyAlerts = hasPerm(state.user,'fabrics') ? collectInconsistencyAlerts() : [];
  return delayAlerts.filter(a=>!isNotifRead(a.key)).length
    + fabricAlerts.filter(a=>!isNotifRead(a.key)).length
    + inconsistencyAlerts.filter(a=>!isNotifRead(a.key)).length;
}

function markAllNotificationsRead(){
  const delayAlerts = collectDelayAlerts();
  const fabricAlerts = collectFabricAlerts();
  const inconsistencyAlerts = collectInconsistencyAlerts();
  markNotificationsRead([...delayAlerts, ...fabricAlerts, ...inconsistencyAlerts].map(a=>a.key));
}

function renderNotificationsView(){
  initNotificationsState();
  const delayAlerts = collectDelayAlerts();
  const fabricAlerts = collectFabricAlerts();
  const inconsistencyAlerts = collectInconsistencyAlerts();
  const total = delayAlerts.length + fabricAlerts.length + inconsistencyAlerts.length;
  const unread = collectUnreadNotificationCount();
  return `
    <div class="topbar">
      <div><h1 class="display">Notifications</h1><p>${total} item${total===1?'':'s'} need${total===1?'s':''} attention${unread?`, ${unread} unread`:''}</p></div>
      ${unread ? `<div class="row-actions"><button class="btn btn-ghost btn-sm" onclick="markAllNotificationsRead()">Mark all as read</button></div>` : ''}
    </div>
    ${!delayAlerts.length ? `
      <div class="empty-state">No delayed orders right now - everything's still on its original or first-revised shipment date.</div>
    ` : `
      <h2 class="section-heading">Orders delayed multiple times</h2>
      <div class="card">
        ${delayAlerts.map(({order:o, group:g, key})=>{
          const unread = !isNotifRead(key);
          return `
          <div class="style-row ${unread?'notif-unread':''}" onclick="viewDelayedOrder('${o.id}','${key}')">
            <div>
              <div class="style-name">${unread?'<span class="notif-dot" title="Unread"></span>':''}${o.style_no||'(no style number)'} <span class="delay-badge ${delayBadgeClass(o.delay_count)}">${o.delay_count}</span></div>
              <div class="style-meta">${o.description||''} &middot; ${g.id==='pool'?'Unassigned':(g.code||g.container_no)} &middot; Shipment: ${o.po_delivery_date?formatShipDateFull(o.po_delivery_date):'not set'}</div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); viewDelayedOrder('${o.id}','${key}')">View</button>
            </div>
          </div>
        `;}).join('')}
      </div>
    `}
    ${fabricAlerts.length ? `
      <h2 class="section-heading" style="margin-top:20px;">Fabric reports due for renewal</h2>
      <div class="card">
        ${fabricAlerts.map(({report:r, status, key})=>{
          const unread = !isNotifRead(key);
          return `
          <div class="style-row ${unread?'notif-unread':''}" onclick="viewReportRenewalAlert(${r.id},'${key}')">
            <div>
              <div class="style-name">${unread?'<span class="notif-dot" title="Unread"></span>':''}${r.fabric_code} <span class="fabric-status ${status.cls}">${status.label}</span></div>
              <div class="style-meta">${r.report_number?'Report '+r.report_number:''}${r.style_no?' &middot; '+r.style_no:''}${r.composition?' &middot; '+r.composition:''}</div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); viewReportRenewalAlert(${r.id},'${key}')">View</button>
            </div>
          </div>
        `;}).join('')}
      </div>
    ` : ''}
    ${inconsistencyAlerts.length ? `
      <h2 class="section-heading" style="margin-top:20px;">Fabric data inconsistencies</h2>
      <div class="card">
        ${inconsistencyAlerts.map(({flag, key})=>{
          const unread = !isNotifRead(key);
          return `
          <div class="style-row ${unread?'notif-unread':''}" onclick="viewInconsistencyAlert('${flag.fabric_code}','${key}')">
            <div>
              <div class="style-name">${unread?'<span class="notif-dot" title="Unread"></span>':''}${flag.fabric_code}</div>
              <div class="style-meta">${flag.message} &middot; ${formatShipDateShort(flag.created_at.slice(0,10))}</div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); viewInconsistencyAlert('${flag.fabric_code}','${key}')">View</button>
            </div>
          </div>
        `;}).join('')}
      </div>
    ` : ''}
  `;
}

// The order drawer only mounts while the Shipping view itself is showing -
// switch there first so it's actually visible, then open straight to the
// Delays tab, matching the badge's own click target in the grid.
function viewDelayedOrder(orderId, key){
  if (key) markNotificationsRead([key]);
  state.view = 'shipping';
  openShippingDrawer(orderId, 'delays');
}

function viewReportRenewalAlert(reportId, key){
  if (key) markNotificationsRead([key]);
  state.view = 'fabrics';
  openEditTestReport(reportId);
}

function viewInconsistencyAlert(fabricCode, key){
  if (key) markNotificationsRead([key]);
  state.view = 'fabrics';
  const fabric = (state.fabrics||[]).find(f => f.code === fabricCode);
  if (fabric) openEditFabric(fabric.id);
  else render();
}
