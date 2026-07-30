// ---- Finance: admin-only. Profit/margin is computed fresh from raw price
// fields (not the manually-entered profit/margin columns some orders already
// carry from the imported ORDER SCHEDULE - those are ignored on purpose).
//
// Landed cost = actual landed price (k_lp) if set, else the estimate
// (est_lp) - "K LP" bakes in all landed costs + the ROE actually achieved,
// "Factor" is what the estimate is built from before actuals are known.
// Revenue = the actual invoice value once issued (invoice_value_excl),
// else the planned order value (total_rand_excl).
// $ figures use the ROE actually achieved (landed_roe) if set, else the
// planned ROE (roe), to convert the Rand side for side-by-side display.

function initFinanceState(){
  if (!state.finance) state.finance = { orders: [], containers: [] };
  if (state.financeTab === undefined) state.financeTab = 'overview';
}

async function loadFinance(){
  initFinanceState();
  const { orders, containers } = await api('/api/finance');
  state.finance = { orders, containers };
  render();
}

function setFinanceTab(tab){ state.financeTab = tab; render(); }

function num(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function financeOrderMetrics(o){
  const units = num(o.units);
  const landedUnit = num(o.k_lp) || num(o.est_lp);
  const landedCost = landedUnit * units;
  const revenue = num(o.invoice_value_excl) || num(o.total_rand_excl);
  const dollarCost = num(o.true_dollar_total) || num(o.total_dollar_value) || ((num(o.true_dollar_price) || num(o.po_price)) * units);
  const profit = revenue - landedCost;
  const roe = num(o.landed_roe) || num(o.roe);
  const profitUsd = roe ? profit / roe : null;
  const marginPct = revenue ? (profit / revenue * 100) : null;
  return { units, landedCost, revenue, dollarCost, profit, profitUsd, marginPct };
}

function financeSumMetrics(orders){
  const totals = orders.reduce((acc, o) => {
    const m = financeOrderMetrics(o);
    acc.units += m.units;
    acc.landedCost += m.landedCost;
    acc.revenue += m.revenue;
    acc.dollarCost += m.dollarCost;
    acc.profit += m.profit;
    if (m.profitUsd !== null) acc.profitUsd += m.profitUsd; // only orders with a known ROE contribute
    return acc;
  }, { units:0, landedCost:0, revenue:0, dollarCost:0, profit:0, profitUsd:0 });
  totals.marginPct = totals.revenue ? (totals.profit / totals.revenue * 100) : null;
  return totals;
}

function fmtR(n){ return (n===null || n===undefined || isNaN(n)) ? '—' : 'R' + Math.round(n).toLocaleString('en-ZA'); }
function fmtUSD(n){ return (n===null || n===undefined || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString('en-US'); }
function fmtPct(n){ return (n===null || n===undefined || isNaN(n)) ? '—' : n.toFixed(1) + '%'; }

// A container this order belongs to is "delivered" once its own delivered
// flag is set OR it's been removed from the active schedule; deleted
// containers no longer exist as rows here at all, only their orders do -
// an order with a container_id that doesn't resolve to any live container
// counts as delivered/historical too, not lost.
function financeContainerFor(o){
  return state.finance.containers.find(c => String(c.id) === String(o.container_id));
}
function financeIsDelivered(o){
  const c = financeContainerFor(o);
  if (!o.container_id) return false; // unassigned pool - definitionally still active
  return !c || !!c.delivered;
}

function financeOrderRetailer(o){
  return o.style_retailer || 'Unknown';
}

function csvEscape(v){
  const s = (v===null || v===undefined) ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
function exportCsv(filename, rows){
  const csv = rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type:'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderFinanceView(){
  initFinanceState();
  const tab = state.financeTab;
  return `
    <div class="topbar">
      <div><h1 class="display">Finance</h1><p>${state.finance.orders.length} orders across ${state.finance.containers.length} containers</p></div>
    </div>
    <div class="hint" style="margin-top:8px;">Profit and margin are calculated fresh from landed cost and invoice value - not the manually-entered figures some imported orders already carry.</div>
    <div class="tabs" style="margin-top:14px; padding:0;">
      <button class="tab ${tab==='overview'?'active':''}" onclick="setFinanceTab('overview')">Overview</button>
      <button class="tab ${tab==='containers'?'active':''}" onclick="setFinanceTab('containers')">By Container</button>
      <button class="tab ${tab==='orders'?'active':''}" onclick="setFinanceTab('orders')">By Order</button>
      <button class="tab ${tab==='forecast'?'active':''}" onclick="setFinanceTab('forecast')">Income Forecast</button>
    </div>
    <div style="margin-top:16px;">
      ${tab==='overview' ? renderFinanceOverview() : ''}
      ${tab==='containers' ? renderFinanceContainers() : ''}
      ${tab==='orders' ? renderFinanceOrders() : ''}
      ${tab==='forecast' ? renderFinanceForecast() : ''}
    </div>
  `;
}

function financeStatCard(label, value, sub){
  return `<div class="fin-stat"><div class="fin-stat-label">${label}</div><div class="fin-stat-value">${value}</div>${sub?`<div class="fin-stat-sub">${sub}</div>`:''}</div>`;
}

function renderFinanceOverview(){
  const orders = state.finance.orders;
  const active = orders.filter(o => !financeIsDelivered(o));
  const delivered = orders.filter(o => financeIsDelivered(o));
  const all = financeSumMetrics(orders);
  const act = financeSumMetrics(active);
  const del = financeSumMetrics(delivered);
  return `
    <div class="fin-stat-row">
      ${financeStatCard('Total revenue', fmtR(all.revenue))}
      ${financeStatCard('Total landed cost', fmtR(all.landedCost))}
      ${financeStatCard('Total profit', fmtR(all.profit), fmtUSD(all.profitUsd))}
      ${financeStatCard('Overall margin', fmtPct(all.marginPct))}
    </div>
    <h2 class="section-heading" style="margin-top:24px;">Active pipeline (not yet delivered)</h2>
    <div class="fin-stat-row">
      ${financeStatCard('Orders', active.length)}
      ${financeStatCard('$ cost', fmtUSD(act.dollarCost))}
      ${financeStatCard('R revenue', fmtR(act.revenue))}
      ${financeStatCard('R profit', fmtR(act.profit), 'Margin ' + fmtPct(act.marginPct))}
    </div>
    <h2 class="section-heading" style="margin-top:20px;">Delivered / completed</h2>
    <div class="fin-stat-row">
      ${financeStatCard('Orders', delivered.length)}
      ${financeStatCard('$ cost', fmtUSD(del.dollarCost))}
      ${financeStatCard('R revenue', fmtR(del.revenue))}
      ${financeStatCard('R profit', fmtR(del.profit), 'Margin ' + fmtPct(del.marginPct))}
    </div>
    <div class="row-actions" style="margin-top:18px;">
      <button class="btn btn-ghost btn-sm" onclick="exportFinanceOverviewCsv()">Export CSV</button>
    </div>
  `;
}
function exportFinanceOverviewCsv(){
  const orders = state.finance.orders;
  const active = orders.filter(o => !financeIsDelivered(o));
  const delivered = orders.filter(o => financeIsDelivered(o));
  const all = financeSumMetrics(orders), act = financeSumMetrics(active), del = financeSumMetrics(delivered);
  exportCsv('finance-overview.csv', [
    ['Segment','Orders','$ Cost','R Revenue','R Landed Cost','R Profit','Margin %'],
    ['All', orders.length, all.dollarCost.toFixed(2), all.revenue.toFixed(2), all.landedCost.toFixed(2), all.profit.toFixed(2), all.marginPct?.toFixed(1)||''],
    ['Active pipeline', active.length, act.dollarCost.toFixed(2), act.revenue.toFixed(2), act.landedCost.toFixed(2), act.profit.toFixed(2), act.marginPct?.toFixed(1)||''],
    ['Delivered', delivered.length, del.dollarCost.toFixed(2), del.revenue.toFixed(2), del.landedCost.toFixed(2), del.profit.toFixed(2), del.marginPct?.toFixed(1)||''],
  ]);
}

function renderFinanceContainers(){
  const groups = {};
  state.finance.orders.forEach(o => {
    const key = o.container_id || 'pool';
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  });
  const rows = Object.keys(groups).map(key => {
    const c = key === 'pool' ? null : state.finance.containers.find(x => String(x.id) === key);
    const m = financeSumMetrics(groups[key]);
    return { key, label: c ? (c.code || c.container_no || 'Container '+c.id) : 'Unassigned (no container)', delivered: c ? !!c.delivered : false, m, count: groups[key].length };
  }).sort((a,b) => a.label.localeCompare(b.label));
  return `
    <div class="contacts-wrap">
      <table class="contacts-table">
        <thead>
          <tr><th>Container</th><th>Status</th><th>Orders</th><th>$ Cost</th><th>R Revenue</th><th>R Landed Cost</th><th>R Profit</th><th>Margin %</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="name-cell mono">${r.label}</td>
              <td>${r.delivered ? 'Delivered' : 'Active'}</td>
              <td>${r.count}</td>
              <td>${fmtUSD(r.m.dollarCost)}</td>
              <td>${fmtR(r.m.revenue)}</td>
              <td>${fmtR(r.m.landedCost)}</td>
              <td>${fmtR(r.m.profit)}</td>
              <td>${fmtPct(r.m.marginPct)}</td>
            </tr>
          `).join('') || `<tr><td colspan="8"><div class="empty-state">No orders yet.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="row-actions" style="margin-top:14px;">
      <button class="btn btn-ghost btn-sm" onclick="exportFinanceContainersCsv()">Export CSV</button>
    </div>
  `;
}
function exportFinanceContainersCsv(){
  const groups = {};
  state.finance.orders.forEach(o => {
    const key = o.container_id || 'pool';
    if (!groups[key]) groups[key] = [];
    groups[key].push(o);
  });
  const rows = [['Container','Status','Orders','$ Cost','R Revenue','R Landed Cost','R Profit','Margin %']];
  Object.keys(groups).forEach(key => {
    const c = key === 'pool' ? null : state.finance.containers.find(x => String(x.id) === key);
    const m = financeSumMetrics(groups[key]);
    rows.push([
      c ? (c.code || c.container_no || 'Container '+c.id) : 'Unassigned (no container)',
      c ? (c.delivered ? 'Delivered' : 'Active') : 'Active',
      groups[key].length, m.dollarCost.toFixed(2), m.revenue.toFixed(2), m.landedCost.toFixed(2), m.profit.toFixed(2), m.marginPct?.toFixed(1)||''
    ]);
  });
  exportCsv('finance-by-container.csv', rows);
}

function renderFinanceOrders(){
  const orders = state.finance.orders.slice().sort((a,b) => (a.style_no||'').localeCompare(b.style_no||''));
  return `
    <div class="contacts-wrap">
      <table class="contacts-table">
        <thead>
          <tr><th>Style</th><th>Retailer</th><th>Container</th><th>Units</th><th>$ Cost</th><th>R Revenue</th><th>R Landed Cost</th><th>R Profit</th><th>$ Profit</th><th>Margin %</th></tr>
        </thead>
        <tbody>
          ${orders.map(o => {
            const m = financeOrderMetrics(o);
            const c = financeContainerFor(o);
            return `
              <tr>
                <td class="name-cell mono">${o.style_no||'(none)'}</td>
                <td>${financeOrderRetailer(o)}</td>
                <td>${o.container_id ? (c ? (c.code||c.container_no) : '(removed)') : 'Unassigned'}</td>
                <td>${o.units||0}</td>
                <td>${fmtUSD(m.dollarCost)}</td>
                <td>${fmtR(m.revenue)}</td>
                <td>${fmtR(m.landedCost)}</td>
                <td>${fmtR(m.profit)}</td>
                <td>${fmtUSD(m.profitUsd)}</td>
                <td>${fmtPct(m.marginPct)}</td>
              </tr>
            `;
          }).join('') || `<tr><td colspan="10"><div class="empty-state">No orders yet.</div></td></tr>`}
        </tbody>
      </table>
    </div>
    <div class="row-actions" style="margin-top:14px;">
      <button class="btn btn-ghost btn-sm" onclick="exportFinanceOrdersCsv()">Export CSV</button>
    </div>
  `;
}
function exportFinanceOrdersCsv(){
  const orders = state.finance.orders.slice().sort((a,b) => (a.style_no||'').localeCompare(b.style_no||''));
  const rows = [['Style','Retailer','Container','Units','$ Cost','R Revenue','R Landed Cost','R Profit','$ Profit','Margin %']];
  orders.forEach(o => {
    const m = financeOrderMetrics(o);
    const c = financeContainerFor(o);
    rows.push([
      o.style_no||'', financeOrderRetailer(o), o.container_id ? (c?(c.code||c.container_no):'(removed)') : 'Unassigned',
      o.units||0, m.dollarCost.toFixed(2), m.revenue.toFixed(2), m.landedCost.toFixed(2), m.profit.toFixed(2),
      m.profitUsd!==null?m.profitUsd.toFixed(2):'', m.marginPct!==null?m.marginPct.toFixed(1):''
    ]);
  });
  exportCsv('finance-by-order.csv', rows);
}

// Forecast = revenue not yet collected (no elanza_paid date), bucketed by
// the month it's due. Orders with no payment_due date at all are shown
// separately rather than silently dropped, so nothing goes missing from view.
function financeForecastData(){
  const pending = state.finance.orders.filter(o => !o.elanza_paid);
  const today = new Date();
  const buckets = {};
  const overdue = [];
  const noDueDate = [];
  pending.forEach(o => {
    if (!o.payment_due) { noDueDate.push(o); return; }
    const d = parseShipDate(o.payment_due);
    if (!d) { noDueDate.push(o); return; }
    if (d < today) { overdue.push(o); return; }
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(o);
  });
  const monthKeys = Object.keys(buckets).sort();
  return { overdue, noDueDate, monthKeys, buckets };
}
function financeMonthLabel(key){
  const [y,m] = key.split('-').map(Number);
  return new Date(y, m-1, 1).toLocaleDateString('en-GB', { month:'long', year:'numeric' });
}
function renderFinanceForecast(){
  const { overdue, noDueDate, monthKeys, buckets } = financeForecastData();
  const overdueM = financeSumMetrics(overdue);
  return `
    <div class="fin-stat-row">
      ${financeStatCard('Overdue revenue', fmtR(overdueM.revenue), overdue.length + ' order' + (overdue.length===1?'':'s') + ' past payment due')}
      ${financeStatCard('Orders awaiting payment', overdue.length + monthKeys.reduce((s,k)=>s+buckets[k].length,0))}
      ${financeStatCard('Missing a payment due date', noDueDate.length)}
    </div>
    ${overdue.length ? `
      <h2 class="section-heading" style="margin-top:22px; color:var(--stitch-red);">Overdue</h2>
      <div class="contacts-wrap">
        <table class="contacts-table">
          <thead><tr><th>Style</th><th>Retailer</th><th>Payment due</th><th>R Revenue</th></tr></thead>
          <tbody>${overdue.slice().sort((a,b)=>(a.payment_due||'').localeCompare(b.payment_due||'')).map(o=>`
            <tr><td class="name-cell mono">${o.style_no||'(none)'}</td><td>${financeOrderRetailer(o)}</td><td>${formatShipDateShort(o.payment_due)}</td><td>${fmtR(financeOrderMetrics(o).revenue)}</td></tr>
          `).join('')}</tbody>
        </table>
      </div>
    ` : ''}
    <h2 class="section-heading" style="margin-top:22px;">Forecast by month</h2>
    ${!monthKeys.length ? `<div class="empty-state">Nothing pending with a payment due date.</div>` : `
      <div class="contacts-wrap">
        <table class="contacts-table">
          <thead><tr><th>Month</th><th>Orders</th><th>R Revenue forecast</th></tr></thead>
          <tbody>${monthKeys.map(k => {
            const m = financeSumMetrics(buckets[k]);
            return `<tr><td>${financeMonthLabel(k)}</td><td>${buckets[k].length}</td><td>${fmtR(m.revenue)}</td></tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    `}
    ${noDueDate.length ? `<div class="hint" style="margin-top:14px;">${noDueDate.length} order${noDueDate.length===1?'':'s'} have no payment due date set, so they're not included in the forecast above.</div>` : ''}
    <div class="row-actions" style="margin-top:14px;">
      <button class="btn btn-ghost btn-sm" onclick="exportFinanceForecastCsv()">Export CSV</button>
    </div>
  `;
}
function exportFinanceForecastCsv(){
  const { overdue, noDueDate, monthKeys, buckets } = financeForecastData();
  const rows = [['Bucket','Style','Retailer','Payment due','R Revenue']];
  overdue.forEach(o => rows.push(['Overdue', o.style_no||'', financeOrderRetailer(o), o.payment_due||'', financeOrderMetrics(o).revenue.toFixed(2)]));
  monthKeys.forEach(k => buckets[k].forEach(o => rows.push([financeMonthLabel(k), o.style_no||'', financeOrderRetailer(o), o.payment_due||'', financeOrderMetrics(o).revenue.toFixed(2)])));
  noDueDate.forEach(o => rows.push(['No due date', o.style_no||'', financeOrderRetailer(o), '', financeOrderMetrics(o).revenue.toFixed(2)]));
  exportCsv('finance-forecast.csv', rows);
}
