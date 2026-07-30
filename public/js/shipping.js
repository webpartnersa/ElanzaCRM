// ---- Shipping Schedule: containers, drag-to-consolidate, capacity bars,
// delivery-date grouping, auto-suggest with bail-packing. Ported from
// reference-shipping-schedule-demo.html - see that file's history for the
// confirmed interaction design. Orders arrive automatically from the Style
// pipeline (routes/styles.js) once a style's stage reaches 'po' ("PO
// Confirmed") - this view is for grouping/shipping them, not creating them.

const CONTAINER_CAPACITY = { '20FT': 28, '40FT GP': 58, '40FT NOR': 55, '40FT HQ': 68 };
// Column widths for every per-container table below - a <colgroup> (rather
// than relying on the header row's cell widths) keeps table-layout:fixed
// consistent regardless of how few rows a given container has. Keep in
// sync with the .fz-*/.col-* widths in style.css.
const SCHEDULE_COLGROUP = `
  <colgroup>
    <col style="width:34px"><col style="width:64px"><col style="width:90px"><col style="width:130px">
    <col style="width:60px"><col style="width:105px"><col style="width:105px"><col style="width:100px">
    <col style="width:190px"><col style="width:95px"><col style="width:70px"><col style="width:90px">
    <col style="width:155px"><col style="width:90px"><col style="width:90px"><col style="width:90px">
    <col style="width:80px"><col style="width:80px">
  </colgroup>`;
// The column-label row for each container's own table (see
// renderShippingGroupBlock - each container gets its own <table>, not one
// shared table for the whole grid, specifically so this can be that
// table's first row with no positioning tricks needed at all).
const GROUP_COLUMN_HEADER_ROW = `
  <tr class="group-column-header">
    <td class="fz fz-0"></td>
    <td class="fz fz-edit"></td>
    <td class="fz fz-container">Container No.</td>
    <td class="fz fz-shipment">Shipment Date</td>
    <td class="fz fz-cbm">CBM</td>
    <td class="fz fz-actualdc">Actual DC Date</td>
    <td class="fz fz-dcdate">DC Date</td>
    <td class="fz fz-style">Style</td>
    <td class="col-desc">Description</td>
    <td class="fz fz-orderno">Order No</td>
    <td class="col-units">Units</td>
    <td class="col-colour">Colour</td>
    <td class="fz fz-fabricapproved">Date Fabric Approved</td>
    <td class="fz fz-fit">Fit</td>
    <td class="fz fz-preprod">Pre Prod</td>
    <td class="fz fz-preship">Pre Ship</td>
    <td class="fz fz-priceusd">$ Price</td>
    <td class="fz fz-pricerand">R Price</td>
  </tr>`;
const ORDER_DRAWER_FIELDS = [
  'description','colour','units','rsp','season','fabric_code','sent_to_factory','labdip','fabric_test','fit','preprod','preship',
  'po_price','rand_excl','roe','landed','profit','margin','supp_inv','supp_inv_date','actual_dc','payment_due','invoice_value','elanza_paid',
  'rms_article_no','import_code','composition','po_cartons','true_cartons','true_cbm','units_shipped',
  'cads','fabric_test_start','fabric_approved','fabric_sent_to_buyer','finv','warehouse_work_done','warehouse_packing_list',
  'true_dollar_price','rand_incl','total_rand_excl','total_rand_incl','total_dollar_value','true_dollar_total',
  'est_lp','k_lp','landed_roe','factor','profit_per_item','cents','pct',
  'payment_terms','pop_received_date','invoice_value_excl','discount_terms','addendum_discounts',
  'elanza_inv','elanza_ttl_inv_paid','liverpool_payment_date'
];

function initShippingState(){
  if (!state.shipping) state.shipping = { containers: [], unassigned: [] };
  if (state.shippingGroupingWindowDays === undefined) state.shippingGroupingWindowDays = 21;
  if (state.shippingOverageAllowanceCbm === undefined) state.shippingOverageAllowanceCbm = 3;
  if (state.shippingSuggestion === undefined) state.shippingSuggestion = null;
  if (state.shippingDragSourceId === undefined) state.shippingDragSourceId = null;
  if (state.shippingStatusFilter === undefined) state.shippingStatusFilter = '';
}

// Maps an order onto one of the three filter buckets - delivered (its own
// dc_status, set from the order drawer) takes priority over the
// container's transit status, since an individual order can clear its DC
// before the rest of the container does. "Being shipped" covers both
// on-the-water and landed (still hasn't reached the retailer), everything
// else (no transit status set yet) is still in processing.
function orderShippingStatus(o, g){
  if (o.dc_status === 'delivered') return 'delivered';
  if (g.transit_status === 'on_water' || g.transit_status === 'landed') return 'shipped';
  return 'processing';
}
function setShippingStatusFilter(val){ state.shippingStatusFilter = val; render(); }

async function loadShipping(){
  initShippingState();
  const { containers, unassigned } = await api('/api/shipping');
  state.shipping = { containers, unassigned };
  render();
}

// Assembles the demo's original "pool + containers" array shape fresh on
// every render, from the two separately-persisted pieces of state - the
// pool is a client-only pseudo-group, never a real container row.
function shippingGroups(){
  // Returns direct references to the real container objects (not copies) -
  // mutations made through a found group (renaming, reordering orders,
  // etc.) must land on the actual state.shipping.containers entries so
  // they survive the next render/re-fetch. Containers render first, the
  // unassigned pool last (matching the reference demo's ordering).
  return [
    ...state.shipping.containers,
    { id: 'pool', container_no: 'Unassigned Orders (awaiting container)', vessel: '-', container_type: null, orders: state.shipping.unassigned }
  ];
}
function findShippingOrder(orderId){
  for (const g of shippingGroups()) {
    const o = g.orders.find(x => String(x.id) === String(orderId));
    if (o) return { group: g, order: o };
  }
  return null;
}
function findShippingGroup(groupId){
  return shippingGroups().find(g => String(g.id) === String(groupId));
}
// The 'pool' group is a fresh wrapper object every call (there's no real
// containers row backing "Unassigned Orders"), with .orders just pointing
// at state.shipping.unassigned. Reassigning group.orders = group.orders
// .filter(...) only replaces that wrapper's property, never the real
// array - so it silently fails to persist for pool-sourced removals.
// Splice mutates the array in place instead, which reaches through the
// wrapper to the real backing array either way (pool or a real container).
function removeOrderFromGroup(group, orderId){
  const idx = group.orders.findIndex(o => String(o.id) === String(orderId));
  if (idx !== -1) group.orders.splice(idx, 1);
}

function setShippingGroupingWindow(val){ state.shippingGroupingWindowDays = parseInt(val,10) || 21; render(); }
function setShippingOverageAllowance(val){ state.shippingOverageAllowanceCbm = parseFloat(val) || 0; render(); }

function parseShipDate(str){
  if (!str) return null;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str) ? new Date(str + 'T00:00:00') : new Date(str);
  return isNaN(d) ? null : d;
}
// toISOString() converts to UTC first - in any timezone ahead of UTC, a
// local midnight rolls back to the previous day once formatted that way,
// silently saving the wrong date. This reads the local Y/M/D directly
// instead, matching how parseShipDate constructed the date in the first place.
function toLocalISODate(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function shipDaysBetween(a, b){ return Math.round(Math.abs(a - b) / (1000*60*60*24)); }
function formatShipDateShort(str){
  const d = parseShipDate(str);
  return d ? d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : (str || '');
}
function formatShipDateCell(str){
  const d = parseShipDate(str);
  return d ? d.toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : (str || '');
}
// Full month name (e.g. "28 July") - the Shipment column specifically, since
// it's the single most important date in the schedule and gets read out
// loud/quoted to the factory, not just glanced at in a tight column.
function formatShipDateFull(str){
  const d = parseShipDate(str);
  return d ? d.toLocaleDateString('en-GB', { day:'numeric', month:'long' }) : (str || '');
}
function shippingDateRange(orders){
  const dates = orders.map(o=>parseShipDate(o.po_delivery_date)).filter(Boolean);
  if (!dates.length) return null;
  const min = new Date(Math.min(...dates));
  const max = new Date(Math.max(...dates));
  return { min, max, spreadDays: shipDaysBetween(min, max) };
}
function sortOrdersByDelivery(orders){
  return orders.sort((a,b)=>{
    const da = parseShipDate(a.po_delivery_date), db = parseShipDate(b.po_delivery_date);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });
}

// ---- View ----
const SHIPPING_STATUS_FILTERS = [
  { key:'', label:'All statuses' },
  { key:'processing', label:'In processing' },
  { key:'shipped', label:'Being shipped' },
  { key:'delivered', label:'Delivered' },
];
function renderShippingView(){
  initShippingState();
  const groups = shippingGroups();
  const filter = state.shippingStatusFilter;
  const visibleOrderCount = groups.reduce((s,g) => s + g.orders.filter(o => !filter || orderShippingStatus(o,g)===filter).length, 0);
  return `
    <div class="topbar">
      <div><h1 class="display">Order Schedule</h1><p>${state.shipping.containers.length} containers · ${visibleOrderCount} order${visibleOrderCount===1?'':'s'}${filter?' matching filter':''}</p></div>
      <div class="row-actions">
        <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-soft);">
          Status
          <select onchange="setShippingStatusFilter(this.value)" style="padding:5px 8px; border:1px solid var(--line); border-radius:var(--radius); font-size:12px; background:#fff;">
            ${SHIPPING_STATUS_FILTERS.map(f=>`<option value="${f.key}" ${filter===f.key?'selected':''}>${f.label}</option>`).join('')}
          </select>
        </div>
        <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-soft);">
          Group within <input type="number" min="1" value="${state.shippingGroupingWindowDays}" style="width:50px; padding:5px 6px; border:1px solid var(--line); border-radius:var(--radius);" onchange="setShippingGroupingWindow(this.value)"/> days
        </div>
        <div style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-soft);">
          Allow over by <input type="number" min="0" step="0.5" value="${state.shippingOverageAllowanceCbm}" style="width:50px; padding:5px 6px; border:1px solid var(--line); border-radius:var(--radius);" onchange="setShippingOverageAllowance(this.value)"/> CBM (bail)
        </div>
        <button class="btn btn-primary" onclick="addShippingContainer()">+ New Container</button>
      </div>
    </div>
    <div class="hint" style="margin-top:8px;">Orders flow in automatically once a style reaches PO Confirmed - this view is for grouping and shipping them, not creating them. Drag any row's ⠿ handle onto another row to move/reorder it. Frozen columns are editable right in the grid; click "Edit" for the rest.</div>

    <div class="suggestion-banner ${state.shippingSuggestion ? 'show' : ''}" id="ship-suggestion-banner">${renderShippingSuggestionBanner()}</div>

    ${groups.map(g=>renderShippingGroupBlock(g, filter)).join('')}
    ${!visibleOrderCount && filter ? `<div class="empty-state" style="margin-top:14px;">No orders match this filter right now.</div>` : ''}
    ${renderShippingDrawerHost()}
  `;
}

// Every attempt to keep a container's name/ETD-ETA/buttons "row" pinned in
// place *inside the same scrolling table* as the order data (position:
// sticky on the row's <td>, sticky-ing an inner div instead, syncing a
// transform to scroll events) ran into some flavor of the same problem:
// that row was never really tabular data, so forcing it to behave like a
// table row while also not scrolling like one is fighting the browser.
// The actual fix is structural - it isn't a table row at all anymore.
// Each container renders as a plain <div> (never inside any scrolling
// container, so it simply can't move horizontally, full stop) followed by
// its own small <table> containing only that container's order rows -
// where the already-reliable per-column position:sticky (.fz-*, proven
// throughout the rest of this grid) freezes Container No through Style
// exactly as it does everywhere else. Multiple independent .schedule-wrap
// scrollers (one per container) are kept in sync via syncScheduleScroll
// below, so scrolling any one of them scrolls all the others with it.
function syncScheduleScroll(wrap){
  const x = wrap.scrollLeft;
  document.querySelectorAll('.schedule-wrap').forEach(w => { if (w !== wrap) w.scrollLeft = x; });
}

function renderShippingGroupBlock(g, filter){
  sortOrdersByDelivery(g.orders);
  // Capacity bar/CBM/vessel totals always reflect the container's true,
  // unfiltered contents - a status filter narrows which order rows show,
  // it doesn't change what's physically in the container. Only the visible
  // rows below are filtered, and the whole block disappears if none match.
  const visibleOrders = filter ? g.orders.filter(o => orderShippingStatus(o,g)===filter) : g.orders;
  if (filter && !visibleOrders.length) return '';
  const totalCbm = g.orders.reduce((s,o)=>s+(parseFloat(o.cbm)||0), 0);
  let detailsHtml, notesHtml = '';
  if (g.id === 'pool') {
    detailsHtml = `
      <div class="container-details" ondragover="event.preventDefault()" ondrop="onShippingDropOnGroup(event,'pool')">
        ${g.container_no}
        <span class="group-meta">${g.orders.length} orders · ${totalCbm.toFixed(1)} CBM total</span>
      </div>`;
  } else {
    const maxCbm = CONTAINER_CAPACITY[g.container_type] || 0;
    const pct = maxCbm ? Math.min(100, (totalCbm/maxCbm)*100) : 0;
    const fillClass = !maxCbm ? '' : (totalCbm > maxCbm ? 'cap-fill-critical' : (pct < 50 ? 'cap-fill-empty' : (pct < 90 ? 'cap-fill-mid' : 'cap-fill-full')));
    const typeOptions = Object.keys(CONTAINER_CAPACITY).map(t=>`<option value="${t}" ${g.container_type===t?'selected':''}>${t}</option>`).join('');
    const range = shippingDateRange(g.orders);
    const rangeWarn = range && range.spreadDays > state.shippingGroupingWindowDays;
    const rangeHtml = !range ? '' :
      `<span class="date-range ${rangeWarn?'warn':''}">${rangeWarn?'⚠ ':''}${formatShipDateShort(range.min)} – ${formatShipDateShort(range.max)}${rangeWarn?` (${range.spreadDays}d apart)`:''}</span>`;
    detailsHtml = `
      <div class="container-details" ondragover="event.preventDefault()" ondrop="onShippingDropOnGroup(event,'${g.id}')">
        <span class="container-code-label" title="Factory-facing reference - assigned once, never changes">${g.code||''}</span>
        <input class="container-name-input" value="${g.container_no||''}" oninput="renameShippingContainerLocal('${g.id}', this.value)" onchange="saveShippingContainer('${g.id}', {container_no:this.value})"/>
        <select onchange="saveShippingContainer('${g.id}', {container_type:this.value})">${typeOptions}</select>
        <span class="etd-eta-label">ETD</span><input class="etd-eta-input" placeholder="ETD" value="${g.etd||''}" oninput="updateShippingContainerFieldLocal('${g.id}','etd',this.value)" onchange="saveShippingContainer('${g.id}', {etd:this.value})"/>
        <span class="etd-eta-label">ETA</span><input class="etd-eta-input" placeholder="ETA" value="${g.eta||''}" oninput="updateShippingContainerFieldLocal('${g.id}','eta',this.value)" onchange="saveShippingContainer('${g.id}', {eta:this.value})"/>
        <span class="cap-bar-wrap">
          <span class="cap-bar"><span class="cap-bar-fill ${fillClass}" style="width:${pct}%;"></span></span>
          <span class="cap-label ${totalCbm>maxCbm?'over':''}">${totalCbm.toFixed(1)} / ${maxCbm} CBM${totalCbm>maxCbm?' - OVER':''}</span>
        </span>
        ${rangeHtml}
        <button class="auto-btn" onclick="autoSuggestShipping('${g.id}')">Auto-suggest</button>
        <button class="auto-btn" style="background:#e9f7ee; border-color:#b7e0c6; color:#1e7a3c;" onclick="markContainerDelivered('${g.id}')">✓ Delivered - remove</button>
        ${transitStatusButtons(g)}
      </div>`;
    notesHtml = `
      <div class="container-notes-bar">
        <input class="notes-input" placeholder="Notes (e.g. bail instructions)..." value="${g.notes||''}" oninput="renameShippingContainerLocal('${g.id}', undefined, this.value)" onchange="saveShippingContainer('${g.id}', {notes:this.value})"/>
      </div>`;
  }

  let rowsHtml = GROUP_COLUMN_HEADER_ROW;
  visibleOrders.forEach(o=>{
    const isSuggested = state.shippingSuggestion && state.shippingSuggestion.orderIds.includes(o.id);
    const isBailSuggested = state.shippingSuggestion && state.shippingSuggestion.bailOrderId === o.id;
    const transitClass = g.transit_status ? `transit-row-${g.transit_status}` : '';
    // Order-level dc_status wins over the container's own transit color when
    // both apply (e.g. a landed container with one order already delivered) -
    // enforced by CSS declaration order, see order-status-* rules.
    const dcStatusClass = o.dc_status ? `order-status-${o.dc_status}` : '';
    const rowClass = [isBailSuggested ? 'bail-suggested-row' : (isSuggested ? 'suggested-row' : ''), transitClass, dcStatusClass].filter(Boolean).join(' ');
    rowsHtml += `
      <tr draggable="true" class="${rowClass}"
          ondragstart="onShippingDragStart(event,'${o.id}')" ondragend="onShippingDragEnd(event)"
          ondragover="event.preventDefault()" ondrop="onShippingDropOnRow(event,'${o.id}')">
        <td class="fz fz-0 drag-handle">⠿</td>
        <td class="fz fz-edit"><button class="edit-btn" onclick="openShippingDrawer('${o.id}')">Edit</button></td>
        <td class="fz fz-container"><input value="${o.container_code||''}" oninput="updateShippingOrderFieldLocal('${o.id}','container_code',this.value)" onchange="saveShippingOrderField('${o.id}','container_code',this.value)"/></td>
        <td class="fz fz-shipment"><input value="${formatShipDateFull(o.po_delivery_date)}" onchange="onShippingDateBlur('${o.id}',this.value)"/>${o.delay_count?`<span class="delay-badge ${delayBadgeClass(o.delay_count)}" title="Shipment date has moved ${o.delay_count} time${o.delay_count===1?'':'s'} - click to see why" onclick="openShippingDrawer('${o.id}','delays')">${o.delay_count}</span>`:''}</td>
        <td class="fz fz-cbm"><input value="${o.cbm||''}" oninput="updateShippingOrderFieldLocal('${o.id}','cbm',this.value); render();" onchange="saveShippingOrderField('${o.id}','cbm',this.value)"/></td>
        <td class="fz fz-actualdc"><input value="${formatShipDateCell(o.actual_dc)}" onchange="updateShippingDateField('${o.id}','actual_dc',this.value)"/></td>
        <td class="fz fz-dcdate"><input value="${formatShipDateCell(o.ck_po_date)}" onchange="updateShippingDateField('${o.id}','ck_po_date',this.value)"/></td>
        <td class="fz fz-style"><input value="${o.style_no||''}" oninput="updateShippingOrderFieldLocal('${o.id}','style_no',this.value)" onchange="saveShippingOrderField('${o.id}','style_no',this.value)"/>${o.bailed?'<span class="bail-badge">BAIL</span>':''}</td>
        <td class="col-desc"><input value="${o.description||''}" oninput="updateShippingOrderFieldLocal('${o.id}','description',this.value)" onchange="saveShippingOrderField('${o.id}','description',this.value)"/></td>
        <td class="fz fz-orderno"><input value="${o.order_no||''}" oninput="updateShippingOrderFieldLocal('${o.id}','order_no',this.value)" onchange="saveShippingOrderField('${o.id}','order_no',this.value)"/></td>
        <td class="col-units"><input value="${o.units||''}" oninput="updateShippingOrderFieldLocal('${o.id}','units',this.value)" onchange="saveShippingOrderField('${o.id}','units',this.value)"/></td>
        <td class="col-colour"><input value="${o.colour||''}" oninput="updateShippingOrderFieldLocal('${o.id}','colour',this.value)" onchange="saveShippingOrderField('${o.id}','colour',this.value)"/></td>
        <td class="fz fz-fabricapproved"><input value="${formatShipDateCell(o.fabric_approved)}" onchange="updateShippingDateField('${o.id}','fabric_approved',this.value)"/></td>
        <td class="fz fz-fit"><input value="${formatShipDateCell(o.fit)}" onchange="updateShippingDateField('${o.id}','fit',this.value)"/></td>
        <td class="fz fz-preprod"><input value="${formatShipDateCell(o.preprod)}" onchange="updateShippingDateField('${o.id}','preprod',this.value)"/></td>
        <td class="fz fz-preship"><input value="${formatShipDateCell(o.preship)}" onchange="updateShippingDateField('${o.id}','preship',this.value)"/></td>
        <td class="fz fz-priceusd"><input value="${o.po_price||''}" oninput="updateShippingOrderFieldLocal('${o.id}','po_price',this.value)" onchange="saveShippingOrderField('${o.id}','po_price',this.value)"/></td>
        <td class="fz fz-pricerand"><input value="${o.rand_excl||''}" oninput="updateShippingOrderFieldLocal('${o.id}','rand_excl',this.value)" onchange="saveShippingOrderField('${o.id}','rand_excl',this.value)"/></td>
      </tr>`;
  });

  return `
    <div class="container-block">
      ${detailsHtml}
      ${notesHtml}
      <div class="schedule-wrap" onscroll="syncScheduleScroll(this)">
        <table>
          ${SCHEDULE_COLGROUP}
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;
}

function renderShippingSuggestionBanner(){
  const suggestion = state.shippingSuggestion;
  if (!suggestion) return '';
  const g = findShippingGroup(suggestion.containerId);
  if (!g) { state.shippingSuggestion = null; return ''; }
  const bailInfo = suggestion.bailOrderId ? findShippingOrder(suggestion.bailOrderId) : null;
  const newTotal = suggestion.used + suggestion.total + (bailInfo ? (parseFloat(bailInfo.order.cbm)||0) : 0);
  const pct = suggestion.maxCbm ? ((newTotal/suggestion.maxCbm)*100).toFixed(0) : 0;
  const totalCount = suggestion.orderIds.length + (bailInfo ? 1 : 0);
  const bailLine = bailInfo ? ` · <strong style="color:var(--stitch-red);">${bailInfo.order.style_no}</strong> highlighted in orange would need bailing (${suggestion.bailOverage.toFixed(1)} CBM over)` : '';
  return `
    <div>
      <strong>Auto-suggest for ${g.container_no}</strong>
      <span class="group-meta">${suggestion.orderIds.length} orders highlighted below — would bring it to ${newTotal.toFixed(1)} / ${suggestion.maxCbm} CBM (${pct}%)${bailLine}</span>
    </div>
    <div>
      <button class="btn btn-ghost" onclick="clearShippingSuggestion()">Clear</button>
      <button class="btn btn-primary" onclick="applyShippingSuggestion()" style="margin-left:8px;">Add these ${totalCount} orders</button>
    </div>`;
}

// ---- Auto-suggest: pure client-side, operates on already-loaded data - no
// AI, just a greedy-fill + date-window heuristic (ported from the demo). ----
function autoSuggestShipping(containerId){
  const g = findShippingGroup(containerId);
  if (!g || !CONTAINER_CAPACITY[g.container_type]) { toast('Select a container type first'); return; }
  const maxCbm = CONTAINER_CAPACITY[g.container_type];
  const used = g.orders.reduce((s,o)=>s+(parseFloat(o.cbm)||0), 0);
  const remaining = maxCbm - used;
  if (remaining <= 0) { toast('Container is already at or over capacity'); return; }

  const pool = state.shipping.unassigned;
  let candidates = pool.filter(o=>(parseFloat(o.cbm)||0) <= remaining + 0.001);

  const existingRange = shippingDateRange(g.orders);
  let dateFiltered = 0;
  if (existingRange) {
    const before = candidates.length;
    candidates = candidates.filter(o=>{
      const d = parseShipDate(o.po_delivery_date);
      if (!d) return true;
      return shipDaysBetween(d, existingRange.min) <= state.shippingGroupingWindowDays && shipDaysBetween(d, existingRange.max) <= state.shippingGroupingWindowDays;
    });
    dateFiltered = before - candidates.length;
  }
  if (!candidates.length) { toast('No unassigned orders both fit the space and match the delivery window'); return; }

  function greedyFill(list){
    let total = 0; const chosen = [];
    list.forEach(o=>{
      const cbm = parseFloat(o.cbm) || 0;
      if (total + cbm <= remaining + 0.001) { chosen.push(o.id); total += cbm; }
    });
    return { chosen, total };
  }
  const desc = greedyFill([...candidates].sort((a,b)=>(parseFloat(b.cbm)||0)-(parseFloat(a.cbm)||0)));
  const asc = greedyFill([...candidates].sort((a,b)=>(parseFloat(a.cbm)||0)-(parseFloat(b.cbm)||0)));
  const best = desc.total >= asc.total ? desc : asc;

  const dateOk = (o) => {
    if (!existingRange) return true;
    const d = parseShipDate(o.po_delivery_date);
    if (!d) return true;
    return shipDaysBetween(d, existingRange.min) <= state.shippingGroupingWindowDays && shipDaysBetween(d, existingRange.max) <= state.shippingGroupingWindowDays;
  };
  const leftoverAfterBest = remaining - best.total;
  let bailOrder = null, bailOverage = 0;
  if (state.shippingOverageAllowanceCbm > 0) {
    const bailCandidates = pool
      .filter(o => !best.chosen.includes(o.id) && dateOk(o))
      .filter(o => {
        const cbm = parseFloat(o.cbm) || 0;
        return cbm > leftoverAfterBest + 0.001 && cbm <= leftoverAfterBest + state.shippingOverageAllowanceCbm + 0.001;
      })
      .sort((a,b)=>(parseFloat(a.cbm)||0)-(parseFloat(b.cbm)||0));
    if (bailCandidates.length) {
      bailOrder = bailCandidates[0];
      bailOverage = (parseFloat(bailOrder.cbm)||0) - leftoverAfterBest;
    }
  }

  state.shippingSuggestion = {
    containerId, orderIds: best.chosen, total: best.total, remaining, maxCbm, used,
    bailOrderId: bailOrder ? bailOrder.id : null, bailOverage
  };
  render();
  const skipMsg = dateFiltered ? ` (${dateFiltered} skipped - delivery date too far off)` : '';
  const bailMsg = bailOrder ? ` + 1 more (${bailOrder.style_no}) would fit if bailed, ${bailOverage.toFixed(1)} CBM over` : '';
  toast(`Suggested ${best.chosen.length} orders${skipMsg}${bailMsg}`);
}

async function applyShippingSuggestion(){
  const suggestion = state.shippingSuggestion;
  if (!suggestion) return;
  const g = findShippingGroup(suggestion.containerId);
  if (!g) { state.shippingSuggestion = null; render(); return; }

  const movedIds = [...suggestion.orderIds];
  if (suggestion.bailOrderId) movedIds.push(suggestion.bailOrderId);

  movedIds.forEach(id=>{
    const found = findShippingOrder(id);
    if (!found) return;
    removeOrderFromGroup(found.group, id);
    if (id === suggestion.bailOrderId) found.order.bailed = 1;
    found.order.container_code = g.code || null;
    g.orders.push(found.order);
  });
  state.shipping.unassigned = state.shipping.unassigned.filter(o=>!movedIds.includes(o.id));

  let msg = `Added ${suggestion.orderIds.length} orders (${suggestion.total.toFixed(1)} CBM) to ${g.container_no}`;
  let noteAppend = null;
  if (suggestion.bailOrderId) {
    const bailInfo = findShippingOrder(suggestion.bailOrderId);
    if (bailInfo) {
      noteAppend = `Bail: ${bailInfo.order.style_no} (${bailInfo.order.order_no || 'no order #'}) - over by ${suggestion.bailOverage.toFixed(1)} CBM, auto-suggested`;
      msg += ` + ${bailInfo.order.style_no} bailed`;
    }
  }
  if (noteAppend) g.notes = g.notes ? `${g.notes}\n${noteAppend}` : noteAppend;
  state.shippingSuggestion = null;
  render();
  toast(msg);

  try {
    await api('/api/shipping/move', { method:'PUT', body: JSON.stringify({ containerId: g.id, order: g.orders.map(o=>o.id) }) });
    if (suggestion.bailOrderId) {
      await api('/api/shipping/orders/'+suggestion.bailOrderId, { method:'PUT', body: JSON.stringify({ bailed: 1 }) });
    }
    if (noteAppend) {
      await api('/api/shipping/containers/'+g.id, { method:'PUT', body: JSON.stringify({ notes: g.notes }) });
    }
  } catch(e) {
    toast('Could not save suggestion, reloading: ' + e.message);
    await loadShipping();
  }
}
function clearShippingSuggestion(){ state.shippingSuggestion = null; render(); }

// ---- Field edits: local state updates instantly (matches the demo's live
// feel), the network save fires on blur (onchange) rather than every
// keystroke to avoid a request per character typed. ----
function updateShippingOrderFieldLocal(orderId, field, value){
  const found = findShippingOrder(orderId);
  if (found) found.order[field] = value;
}
async function saveShippingOrderField(orderId, field, value){
  try { await api('/api/shipping/orders/'+orderId, { method:'PUT', body: JSON.stringify({ [field]: value }) }); }
  catch(e) { toast('Could not save: ' + e.message); }
}
async function updateShippingDateField(orderId, field, rawText){
  const found = findShippingOrder(orderId);
  if (!found) return;
  const trimmed = rawText.trim();
  let value = '';
  if (trimmed) {
    const parsed = parseShipDate(trimmed);
    if (parsed) { value = toLocalISODate(parsed); }
    else { value = trimmed; toast('Could not read that as a date - kept as typed'); }
  }
  found.order[field] = value;
  render();
  try { await api('/api/shipping/orders/'+orderId, { method:'PUT', body: JSON.stringify({ [field]: value }) }); }
  catch(e) { toast('Could not save date: ' + e.message); }
}

function renameShippingContainerLocal(containerId, containerNo, notes){
  const g = findShippingGroup(containerId);
  if (!g) return;
  if (containerNo !== undefined) g.container_no = containerNo;
  if (notes !== undefined) g.notes = notes;
  // no render() here - would steal focus mid-typing, see updateContainerNotes-style fields elsewhere for the same fix
}
function updateShippingContainerFieldLocal(containerId, field, value){
  const g = findShippingGroup(containerId);
  if (g) g[field] = value;
}
async function saveShippingContainer(containerId, fields){
  // Applied optimistically before the network round-trip - without this,
  // a field with no separate oninput-local handler (like container_type's
  // <select>) would visually revert on the next render, since nothing
  // would have updated the real state object it reads from.
  const g = findShippingGroup(containerId);
  if (g) Object.assign(g, fields);
  render();
  try {
    await api('/api/shipping/containers/'+containerId, { method:'PUT', body: JSON.stringify(fields) });
  } catch(e) { toast('Could not save: ' + e.message); }
}

// ---- Drag and drop ----
function onShippingDragStart(e, orderId){
  state.shippingDragSourceId = orderId;
  e.dataTransfer.effectAllowed = 'move';
  e.target.closest('tr').classList.add('dragging');
}
function onShippingDragEnd(e){ e.target.closest('tr').classList.remove('dragging'); }

async function moveShippingOrder(orderId, targetGroupId, targetIndex){
  const found = findShippingOrder(orderId);
  if (!found) return;
  const { group: fromGroup, order } = found;
  removeOrderFromGroup(fromGroup, orderId);
  const toGroup = findShippingGroup(targetGroupId);
  const idx = (targetIndex==null) ? toGroup.orders.length : targetIndex;
  // Mirrors the server's own container_code sync (routes/shipping.js's
  // /move handler) so the grid shows it immediately on drop, instead of
  // only after the next full reload.
  order.container_code = toGroup.id !== 'pool' ? (toGroup.code || null) : null;
  toGroup.orders.splice(idx, 0, order);
  render();

  if (toGroup.id !== 'pool') {
    const range = shippingDateRange(toGroup.orders);
    if (range && range.spreadDays > state.shippingGroupingWindowDays) {
      toast(`⚠ Added, but delivery dates in ${toGroup.container_no} now span ${range.spreadDays} days`);
    } else {
      toast(String(fromGroup.id)===String(targetGroupId) ? 'Order reordered' : `Moved to ${toGroup.container_no}`);
    }
  } else {
    toast(String(fromGroup.id)===String(targetGroupId) ? 'Order reordered' : 'Moved to Unassigned Orders');
  }

  try {
    await api('/api/shipping/move', {
      method:'PUT',
      body: JSON.stringify({ containerId: toGroup.id === 'pool' ? null : toGroup.id, order: toGroup.orders.map(o=>o.id) })
    });
  } catch(e) {
    toast('Could not save move, reloading: ' + e.message);
    await loadShipping();
  }
}

function onShippingDropOnRow(e, targetOrderId){
  e.preventDefault();
  const sourceId = state.shippingDragSourceId;
  if (!sourceId || sourceId===targetOrderId) return;
  const targetInfo = findShippingOrder(targetOrderId);
  if (!targetInfo) return;
  const idx = targetInfo.group.orders.findIndex(o=>String(o.id)===String(targetOrderId));
  moveShippingOrder(sourceId, targetInfo.group.id, idx);
  state.shippingDragSourceId = null;
}
function onShippingDropOnGroup(e, groupId){
  e.preventDefault();
  const sourceId = state.shippingDragSourceId;
  if (!sourceId) return;
  moveShippingOrder(sourceId, groupId, null);
  state.shippingDragSourceId = null;
}

// ---- Order drawer ----
function openShippingDrawer(orderId, tab){
  const found = findShippingOrder(orderId);
  if (!found) return;
  state.shippingDrawer = { orderId, tab: tab || 'product', title: found.order.style_no + ' - ' + found.group.container_no };
  render();
}
function closeShippingDrawer(){ state.shippingDrawer = null; render(); }
function setShippingDrawerTab(tab){ state.shippingDrawer.tab = tab; render(); }

// Autofills composition + fabric test number from the picked fabric's
// management-page record. Writes directly onto the in-memory order (not just
// the DOM) since composition lives on the Product tab while this select
// lives on Factory - same cross-tab pattern the drawer already relies on
// (setShippingDrawerTab re-renders from `o` without capturing DOM first).
function onFabricCodePicked(code){
  if (!state.shippingDrawer) return;
  const found = findShippingOrder(state.shippingDrawer.orderId);
  if (!found) return;
  found.order.fabric_code = code;
  const fab = (state.fabrics||[]).find(f=>f.code===code);
  if (fab) {
    found.order.composition = fab.composition || '';
    found.order.fabric_test = fab.report_number || '';
  }
  render();
}

async function saveShippingDrawer(){
  if (!state.shippingDrawer) return;
  const found = findShippingOrder(state.shippingDrawer.orderId);
  if (!found) return;
  const body = {};
  ORDER_DRAWER_FIELDS.forEach(f=>{
    const el = document.getElementById('sd-'+f);
    if (el) { found.order[f] = el.value; body[f] = el.value; }
  });
  try {
    await api('/api/shipping/orders/'+found.order.id, { method:'PUT', body: JSON.stringify(body) });
    toast('Saved');
    closeShippingDrawer();
  } catch(e) { toast('Could not save: ' + e.message); }
}

async function removeShippingOrder(orderId){
  if (!confirm('Remove this order from the Order Schedule? This does not affect the style itself.')) return;
  try {
    await api('/api/shipping/orders/'+orderId, { method:'DELETE' });
    const found = findShippingOrder(orderId);
    if (found) removeOrderFromGroup(found.group, orderId);
    closeShippingDrawer();
    toast('Order removed');
  } catch(e) { toast('Could not remove: ' + e.message); }
}

function renderShippingDrawerHost(){
  const d = state.shippingDrawer;
  if (!d) return `<div class="overlay" onclick="closeShippingDrawer()"></div><div class="drawer"></div>`;
  const found = findShippingOrder(d.orderId);
  if (!found) return '';
  const o = found.order;
  const currentTab = d.tab || 'product';
  const field = (id, label) => `<div class="field"><label>${label}</label><input id="sd-${id}" value="${(o[id]||'').toString().replace(/"/g,'&quot;')}"/></div>`;
  return `
    <div class="overlay open" onclick="closeShippingDrawer()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${d.title}</h2>
        <button class="drawer-close" onclick="closeShippingDrawer()">&times;</button>
      </div>
      <div class="dc-status-row">
        <span class="dc-status-label">DC delivery:</span>
        ${dcStatusButtons(o)}
      </div>
      <div class="tabs">
        <button class="tab ${currentTab==='product'?'active':''}" onclick="setShippingDrawerTab('product')">Product</button>
        <button class="tab ${currentTab==='factory'?'active':''}" onclick="setShippingDrawerTab('factory')">Factory</button>
        <button class="tab ${currentTab==='costing'?'active':''}" onclick="setShippingDrawerTab('costing')">Costing</button>
        <button class="tab ${currentTab==='invoicing'?'active':''}" onclick="setShippingDrawerTab('invoicing')">Invoicing</button>
        <button class="tab ${currentTab==='delays'?'active':''}" onclick="setShippingDrawerTab('delays')">Delays${o.delay_count?' ('+o.delay_count+')':''}</button>
      </div>
      <div class="drawer-body">
        ${currentTab==='product' ? `
          ${o.cad_photo_path ? `
            <div class="cad-preview" style="margin-bottom:16px;" onclick="window.open('${o.cad_photo_path}','_blank')">
              <img src="${o.cad_photo_path}"/>
            </div>
          ` : (o.style_id ? `<div class="drawer-photo-placeholder" style="margin-bottom:16px;">No CAD image on file for this style</div>` : '')}
          ${field('description','Description')}
          <div class="row2">${field('colour','Colour')}${field('units','Units')}</div>
          <div class="row2">${field('rsp','Selling price (RSP)')}${field('season','Season')}</div>
          <div class="row2">${field('rms_article_no','RMS / article number')}${field('import_code','Import code')}</div>
          ${field('composition','Composition')}
          <div class="row2">${field('po_cartons','PO # of cartons')}${field('true_cartons','True cartons')}</div>
          <div class="row2">${field('true_cbm','True CBM')}${field('units_shipped','True units shipped')}</div>
        ` : ''}
        ${currentTab==='factory' ? `
          <div class="field">
            <label>Fabric code</label>
            <select id="sd-fabric_code" onchange="onFabricCodePicked(this.value)">
              <option value="">- Select -</option>
              ${(state.fabrics||[]).slice().sort((a,b)=>a.code.localeCompare(b.code)).map(f=>`<option value="${f.code}" ${o.fabric_code===f.code?'selected':''}>${f.code}</option>`).join('')}
            </select>
            <div class="hint" style="margin-top:4px;">Selecting a code autofills Composition &amp; Fabric test number below. <a href="#" onclick="goto('fabrics');return false;">Manage fabrics</a></div>
          </div>
          ${field('sent_to_factory','Date order sent to factory')}
          ${field('cads','CADs')}
          <div class="row2">${field('labdip','Labdip / trim approval')}${field('fabric_test','Fabric test number')}</div>
          <div class="row2">${field('fabric_test_start','Fabric test report start date')}${field('fabric_approved','Date fabric approved')}</div>
          ${field('fabric_sent_to_buyer','Original fabric sent to buyer')}
          <div class="row2">${field('fit','Fit date')}${field('preprod','Pre-prod date')}</div>
          ${field('preship','Pre-ship date')}
          <div class="row2">${field('finv','FINV')}${field('warehouse_work_done','Warehouse work done')}</div>
          ${field('warehouse_packing_list','Warehouse packing list')}
        ` : ''}
        ${currentTab==='costing' ? `
          <div class="row2">${field('po_price','PO $ price')}${field('true_dollar_price','True $ price')}</div>
          <div class="row2">${field('rand_excl','Rand price excl VAT (unit)')}${field('rand_incl','Rand price incl VAT (unit)')}</div>
          <div class="row2">${field('total_rand_excl','Total rand price excl VAT')}${field('total_rand_incl','Total rand price incl VAT')}</div>
          <div class="row2">${field('total_dollar_value','Total $ value')}${field('true_dollar_total','True $ total (shipped)')}</div>
          <div class="row2">${field('est_lp','Est. landed price')}${field('k_lp','K LP')}</div>
          <div class="row2">${field('roe','ROE')}${field('landed_roe','Landed ROE')}</div>
          <div class="row2">${field('factor','Factor')}${field('landed','Total landed')}</div>
          <div class="row2">${field('profit_per_item','R profit / item')}${field('profit','Total profit (R)')}</div>
          <div class="row2">${field('margin','Margin %')}${field('cents','Cents')}</div>
          ${field('pct','%')}
        ` : ''}
        ${currentTab==='invoicing' ? `
          <div class="row2">${field('supp_inv','Supplier invoice #')}${field('supp_inv_date','Supplier inv date')}</div>
          <div class="row2">${field('actual_dc','Actual DC date')}${field('payment_due','Payment due')}</div>
          <div class="row2">${field('payment_terms','Payment terms from month end')}${field('pop_received_date','Date POP received')}</div>
          <div class="row2">${field('invoice_value_excl','Invoice rand value excl VAT')}${field('invoice_value','Invoice rand value incl VAT')}</div>
          <div class="row2">${field('discount_terms','Client discount terms')}${field('addendum_discounts','Addendum discounts')}</div>
          <div class="row2">${field('elanza_inv','Elanza invoice #')}${field('elanza_ttl_inv_paid','Elanza total invoice paid')}</div>
          <div class="row2">${field('elanza_paid','Elanza inv paid date')}${field('liverpool_payment_date','Liverpool payment date to us')}</div>
        ` : ''}
        ${currentTab==='delays' ? renderShippingDelaysTab(o) : ''}
      </div>
      <footer class="drawer-actions">
        <button class="btn btn-danger" style="margin-right:auto;" onclick="removeShippingOrder('${o.id}')">Remove</button>
        <button class="btn btn-primary" onclick="saveShippingDrawer()">Save changes</button>
      </footer>
    </div>`;
}

// ---- Shipment date delays: replaces the old "13 June was 6 June was 30
// May..." run-on text the source spreadsheet used - each push-out is
// logged as its own record with a reason, and the count drives an
// escalation badge in the grid so a repeatedly-delayed order stands out. ----
function delayBadgeClass(count){
  if (count >= 4) return 'delay-badge-critical';
  if (count === 3) return 'delay-badge-warn';
  return 'delay-badge-mild';
}

function renderShippingDelaysTab(o){
  const delays = o.delays || [];
  if (!delays.length) {
    return `<p class="hint">No delays logged - this order is still on its original shipment date.</p>`;
  }
  return `
    <p class="hint" style="margin-bottom:14px;">Shipment date has moved ${delays.length} time${delays.length===1?'':'s'}. Oldest first.</p>
    ${delays.map((d,i)=>`
      <div class="delay-entry">
        <div class="delay-entry-head">
          <span class="delay-badge ${delayBadgeClass(i+1)}">${i+1}</span>
          <span class="mono">${formatShipDateShort(d.old_date)} &rarr; ${formatShipDateShort(d.new_date)}</span>
          <span class="delay-entry-when">${new Date(d.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})}</span>
        </div>
        <div class="delay-entry-reason">${d.reason}</div>
      </div>
    `).join('')}`;
}

// Intercepts an edit to the shipment date column specifically - a
// first-time entry (order currently has no po_delivery_date) or a
// non-change saves straight through like any other field; overwriting an
// existing date requires a reason first, via the shipDelay modal below.
function onShippingDateBlur(orderId, rawText){
  const found = findShippingOrder(orderId);
  if (!found) return;
  const order = found.order;
  const trimmed = rawText.trim();
  let newValue = '';
  if (trimmed) {
    const parsed = parseShipDate(trimmed);
    newValue = parsed ? toLocalISODate(parsed) : trimmed;
  }

  if (order.po_delivery_date && newValue && newValue !== order.po_delivery_date) {
    state.modal = { type:'shipDelay', orderId, oldDate: order.po_delivery_date, newDate: newValue };
    render();
    return;
  }
  updateShippingDateField(orderId, 'po_delivery_date', rawText);
}

async function submitShipDelay(){
  const m = state.modal;
  if (!m || m.type !== 'shipDelay') return;
  const reason = document.getElementById('delay-reason').value.trim();
  if (!reason) { toast('A reason is required'); return; }
  try {
    const { order: updated } = await api('/api/shipping/orders/'+m.orderId+'/delays', {
      method:'POST', body: JSON.stringify({ new_date: m.newDate, reason })
    });
    const found = findShippingOrder(m.orderId);
    if (found) Object.assign(found.order, updated);
    state.modal = null;
    render();
    toast(`Shipment date updated (moved ${updated.delay_count} time${updated.delay_count===1?'':'s'})`);
  } catch(e) { toast('Could not save: ' + e.message); }
}
function cancelShipDelay(){ state.modal = null; render(); }

// ---- Containers ----
async function addShippingContainer(){
  try {
    const { container } = await api('/api/shipping/containers', { method:'POST', body: JSON.stringify({ vessel:'TBA', container_type:'40FT HQ' }) });
    state.shipping.containers.push(container);
    render();
    toast(`${container.code} added — set its type above and drag orders in`);
  } catch(e) { toast('Could not create container: ' + e.message); }
}

async function markContainerDelivered(containerId){
  const g = findShippingGroup(containerId);
  if (!g) return;
  const count = g.orders.length;
  if (!confirm(`Remove ${g.container_no} from the schedule? This assumes it's been delivered${count ? ` - it still has ${count} order${count===1?'':'s'} in it` : ''}.`)) return;
  try {
    await api('/api/shipping/containers/'+containerId, { method:'PUT', body: JSON.stringify({ delivered: 1 }) });
    state.shipping.containers = state.shipping.containers.filter(c=>String(c.id)!==String(containerId));
    render();
    toast(`${g.container_no} removed`);
  } catch(e) { toast('Could not remove: ' + e.message); }
}

// Lightweight in-transit tracking (on the water / landed in Durban) -
// separate from the "Delivered - remove" button above, which is the final
// step that drops the container out of the active schedule entirely. This
// just colors the container's order rows so its progress is visible at a
// glance while it's still on the board. Delivery itself isn't a container-
// level status - a landed container's orders don't all clear DC space on
// the same day, so that's tracked per order (dc_status, set from the order
// drawer) instead - see dcStatusButtons below.
const TRANSIT_STATUSES = [
  { key:'on_water', label:'On the water' },
  { key:'landed', label:'Landed' },
];
function transitStatusButtons(g){
  return `<span class="transit-toggle">${TRANSIT_STATUSES.map(s=>
    `<button type="button" class="transit-btn transit-${s.key} ${g.transit_status===s.key?'active':''}" onclick="setContainerTransitStatus('${g.id}','${s.key}')">${s.label}</button>`
  ).join('')}</span>`;
}
function setContainerTransitStatus(containerId, status){
  const g = findShippingGroup(containerId);
  if (!g) return;
  const next = g.transit_status === status ? '' : status; // click the active one again to clear it
  saveShippingContainer(containerId, { transit_status: next });
}

// Per-order DC delivery status - set from the order drawer, not the
// container header, since a landed container's orders don't all clear DC
// space on the same day. Saves immediately (like the container toggle
// above), independent of the drawer's own "Save changes" button.
const DC_STATUSES = [
  { key:'delivered', label:'Delivered' },
  { key:'delayed', label:'Delayed' },
];
function dcStatusButtons(o){
  return `<span class="dc-status-toggle">${DC_STATUSES.map(s=>
    `<button type="button" class="dc-status-btn dc-status-${s.key} ${o.dc_status===s.key?'active':''}" onclick="setOrderDcStatus('${o.id}','${s.key}')">${s.label}</button>`
  ).join('')}</span>`;
}
async function setOrderDcStatus(orderId, status){
  const found = findShippingOrder(orderId);
  if (!found) return;
  const next = found.order.dc_status === status ? '' : status; // click the active one again to clear it
  found.order.dc_status = next;
  render();
  try {
    await api('/api/shipping/orders/'+orderId, { method:'PUT', body: JSON.stringify({ dc_status: next }) });
  } catch(e) { toast('Could not save: ' + e.message); }
}
