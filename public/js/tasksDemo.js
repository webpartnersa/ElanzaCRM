// ---- Tasks (PROTOTYPE) ----
// Not a real feature yet - built to show Elanza two possible shapes for a
// per-order status/follow-up view and let her pick one before anything gets
// built for real. Field names/shape (style_no, description, sample/fabric/
// bulk status, factory ex-date, shipment, buyer delivery) mirror what's
// already tracked on a real order in the Shipping Schedule - only the
// outstanding/follow-up/responsible fields are new, since nothing tracks
// those yet. There are 0 real orders in the system at the time this was
// built (everything's still at concept stage), so this is 100%
// hand-written sample data, never written to the database - delete this
// file + its nav entry once a decision is made.
//
// Both views render from the same DEMO_ORDERS list so the comparison is
// apples-to-apples: "By Order" shows just the first/primary task per order
// (a single next-action, simple fields on the order itself); "Task List"
// shows every task per order (multiple concurrent outstanding items - the
// point where this starts looking like an actual task manager rather than
// a few extra fields).
const DEMO_ORDERS = [
  {
    style_no: 'PB3055', description: 'Boys Rugby Fleece',
    sample: { label: 'Approved', state: 'ok' },
    fabric: { label: 'Ordered', state: 'ok' },
    bulk: { label: 'In progress', state: 'progress' },
    factory_ex_date: '24 Aug', shipment_date: '29 Aug', buyer_delivery_date: '18 Sep',
    tasks: [
      { outstanding: 'Factory to confirm final packing list', responsible: 'Assistant', last_followup: 'Today 08:42', next_followup: 'Tomorrow 09:00', status: 'open' },
    ],
  },
  {
    style_no: 'PG2041', description: 'Girls Wide Leg Denim',
    sample: { label: 'Approved', state: 'ok' },
    fabric: { label: 'Awaiting lab dip', state: 'progress' },
    bulk: { label: 'Not started', state: 'blocked' },
    factory_ex_date: '02 Sep', shipment_date: '08 Sep', buyer_delivery_date: '28 Sep',
    tasks: [
      { outstanding: 'Awaiting PP sample approval from buyer', responsible: 'Elanza', last_followup: 'Yesterday 16:10', next_followup: 'Overdue by 1 day', status: 'overdue' },
      { outstanding: 'Lab dip resubmission from Wofeng', responsible: 'Wofeng', last_followup: '3 days ago', next_followup: 'Today', status: 'open' },
    ],
  },
  {
    style_no: 'PL021B', description: 'Ladies Skinny Jean',
    sample: { label: 'Approved', state: 'ok' },
    fabric: { label: 'Ordered', state: 'ok' },
    bulk: { label: 'Shipped', state: 'ok' },
    factory_ex_date: '10 Aug', shipment_date: '14 Aug', buyer_delivery_date: '02 Sep',
    tasks: [
      { outstanding: 'None - on track', responsible: '—', last_followup: '2 days ago', next_followup: 'None needed', status: 'done' },
    ],
  },
  {
    style_no: 'COB003', description: 'Older Boys Cutline Jogger',
    sample: { label: 'Awaiting approval', state: 'progress' },
    fabric: { label: 'Not ordered', state: 'blocked' },
    bulk: { label: 'Not started', state: 'blocked' },
    factory_ex_date: '20 Sep', shipment_date: '25 Sep', buyer_delivery_date: '15 Oct',
    tasks: [
      { outstanding: 'Buyer to approve sample before fabric can be ordered', responsible: 'Buyer (PnP)', last_followup: 'Today 09:15', next_followup: 'In 2 days', status: 'open' },
    ],
  },
];

const TASK_STATE_ICON = { ok: '✅', progress: '🟠', blocked: '🔴' };
// Not reusing the existing .badge class here - it's absolutely positioned
// for the concept-card's corner department tag, wrong fit for an inline
// status pill next to text.
const STATUS_PILL_STYLE = 'display:inline-block;font-size:9pt;font-weight:600;padding:2px 8px;border-radius:9px;';
const TASK_STATUS_BADGE = {
  open: `<span style="${STATUS_PILL_STYLE}background:#EEF1F5;color:#445;">Open</span>`,
  overdue: `<span style="${STATUS_PILL_STYLE}background:#F6E4E4;color:var(--stitch-red);">Overdue</span>`,
  done: `<span style="${STATUS_PILL_STYLE}background:#E5F3EA;color:#1E7A3D;">Done</span>`,
};

function initTasksDemoState(){
  if (!state.tasksDemoView) state.tasksDemoView = 'byOrder';
}
function setTasksDemoView(v){ state.tasksDemoView = v; render(); }

function renderTasksDemoView(){
  initTasksDemoState();
  return `
    <div class="topbar">
      <div><h1 class="display">Tasks</h1><p>Prototype - two possible layouts for discussion, not live data</p></div>
      <div class="row-actions">
        <button class="btn ${state.tasksDemoView==='byOrder'?'btn-primary':'btn-ghost'}" onclick="setTasksDemoView('byOrder')">By Order</button>
        <button class="btn ${state.tasksDemoView==='taskList'?'btn-primary':'btn-ghost'}" onclick="setTasksDemoView('taskList')">Task List</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:16px;background:#FFF6E0;padding:10px;border-radius:var(--radius);">
      PROTOTYPE - every row below is hand-written sample data, not pulled from a real order (there are no real orders in the system yet). Built to compare two shapes for a status/follow-up view before building either for real.
    </div>
    ${state.tasksDemoView === 'byOrder' ? renderTasksByOrder() : renderTasksList()}
  `;
}

// "By Order" - one card per order, a single next-action (the order's first
// task only). Simple: this is really just a handful of extra fields on the
// order itself, not a separate task entity.
function renderTasksByOrder(){
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;">
    ${DEMO_ORDERS.map(o => {
      const t = o.tasks[0];
      return `
      <div class="card" style="padding:16px;">
        <div class="style-name" style="font-size:16px;margin-bottom:8px;">${o.style_no} <span class="hint" style="font-weight:400;">${o.description}</span></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:13.5px;margin-bottom:10px;">
          <div>Sample: ${TASK_STATE_ICON[o.sample.state]} ${o.sample.label}</div>
          <div>Fabric: ${TASK_STATE_ICON[o.fabric.state]} ${o.fabric.label}</div>
          <div>Bulk production: ${TASK_STATE_ICON[o.bulk.state]} ${o.bulk.label}</div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;font-size:13px;color:var(--ink-soft,#667);margin-bottom:10px;">
          <div>Factory ex-date<br><strong style="color:var(--ink);">${o.factory_ex_date}</strong></div>
          <div>Shipment<br><strong style="color:var(--ink);">${o.shipment_date}</strong></div>
          <div>Buyer delivery<br><strong style="color:var(--ink);">${o.buyer_delivery_date}</strong></div>
        </div>
        <div style="border-top:1px solid var(--line);padding-top:10px;font-size:13.5px;">
          <div><strong>Outstanding:</strong> ${t.outstanding}</div>
          <div class="hint" style="margin-top:4px;">Last follow-up: ${t.last_followup} &middot; Next follow-up: ${t.next_followup}</div>
          <div class="hint">Responsible: ${t.responsible} ${TASK_STATUS_BADGE[t.status]}</div>
        </div>
      </div>
    `;}).join('')}
  </div>`;
}

// "Task List" - every task per order shown as its own row. This is the
// version that's genuinely a small task manager: an order can have several
// concurrent outstanding items, each tracked/followed-up independently.
function renderTasksList(){
  return DEMO_ORDERS.map(o => `
    <div class="card" style="padding:0;margin-bottom:14px;overflow:hidden;">
      <div style="padding:12px 16px;background:var(--line-soft);border-bottom:1px solid var(--line);">
        <span class="style-name">${o.style_no}</span> <span class="hint">${o.description}</span>
      </div>
      <div class="contacts-wrap">
        <table class="contacts-table">
          <thead><tr><th>Outstanding</th><th>Responsible</th><th>Last follow-up</th><th>Next follow-up</th><th>Status</th></tr></thead>
          <tbody>
            ${o.tasks.map(t => `
              <tr>
                <td>${t.outstanding}</td>
                <td>${t.responsible}</td>
                <td>${t.last_followup}</td>
                <td>${t.next_followup}</td>
                <td>${TASK_STATUS_BADGE[t.status]}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `).join('');
}
