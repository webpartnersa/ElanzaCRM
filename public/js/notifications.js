// ---- Notification Centre: computed live from real data, not a stored/
// scheduled system - starts with two checks (orders delayed multiple times,
// fabric approvals due for renewal), more can be added the same way later.
//
// Read/unread is tracked separately (notification_reads table) since these
// alerts themselves aren't stored rows. Each alert's notifKey bakes in its
// current value (delay_count, fabric approval_date) - if that value changes
// later, the key changes too and it naturally reappears as unread, with no
// separate "did this change since last read" logic needed. ----
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

// Reuses fabricStatus/fabricExpiry from fabrics.js - same 30-day warn
// threshold as the badge on the Fabrics list, just filtered down to the
// codes that actually need attention (warn or already expired).
function collectFabricAlerts(){
  if (!state.fabrics) return [];
  return state.fabrics
    .map(f => ({ fabric: f, status: fabricStatus(f), key: `fabric:${f.id}:${f.approval_date||'none'}` }))
    .filter(({status}) => status.cls==='fabric-status-warn' || status.cls==='fabric-status-expired')
    .sort((a,b) => {
      const da = fabricExpiry(a.fabric.approval_date), db = fabricExpiry(b.fabric.approval_date);
      return (da?da.getTime():0) - (db?db.getTime():0);
    });
}

function collectUnreadNotificationCount(){
  const delayAlerts = hasPerm(state.user,'shipping') ? collectDelayAlerts() : [];
  const fabricAlerts = hasPerm(state.user,'fabrics') ? collectFabricAlerts() : [];
  return delayAlerts.filter(a=>!isNotifRead(a.key)).length + fabricAlerts.filter(a=>!isNotifRead(a.key)).length;
}

function markAllNotificationsRead(){
  const delayAlerts = collectDelayAlerts();
  const fabricAlerts = collectFabricAlerts();
  markNotificationsRead([...delayAlerts, ...fabricAlerts].map(a=>a.key));
}

function renderNotificationsView(){
  initNotificationsState();
  const delayAlerts = collectDelayAlerts();
  const fabricAlerts = collectFabricAlerts();
  const total = delayAlerts.length + fabricAlerts.length;
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
      <h2 class="section-heading" style="margin-top:20px;">Fabric approvals due for renewal</h2>
      <div class="card">
        ${fabricAlerts.map(({fabric:f, status, key})=>{
          const unread = !isNotifRead(key);
          return `
          <div class="style-row ${unread?'notif-unread':''}" onclick="viewFabricAlert(${f.id},'${key}')">
            <div>
              <div class="style-name">${unread?'<span class="notif-dot" title="Unread"></span>':''}${f.code} <span class="fabric-status ${status.cls}">${status.label}</span></div>
              <div class="style-meta">${f.composition||''}${f.report_number?' &middot; Report '+f.report_number:''}</div>
            </div>
            <div class="row-actions">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); viewFabricAlert(${f.id},'${key}')">View</button>
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

function viewFabricAlert(fabricId, key){
  if (key) markNotificationsRead([key]);
  state.view = 'fabrics';
  openEditFabric(fabricId);
}
