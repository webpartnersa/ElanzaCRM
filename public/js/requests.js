// ---- Requests: a permanent record of every factory communication sent
// from a concept - cost/quotation, sample, PP sample, bulk sample, fabric
// test (see REQUEST_TYPES below and routes/concepts.js's send-request
// route) - who it went to, when, and the exact email content, since that's
// gone the moment it leaves this server otherwise. Also the one place to
// answer "which styles am I still waiting on a factory reply for" - status
// is a simple manual awaiting/received toggle (see PUT /:id/status), not
// anything parsed out of a reply email. ----

// Mirrors REQUEST_TYPES in lib/conceptCostingTranslate.js - duplicated
// rather than fetched, since it's a small fixed enum that isn't expected to
// change often; keep the two in sync by hand if it does.
// Chinese values on hold for now (2026-08-06) - see the twin REQUEST_TYPES
// in lib/conceptCostingTranslate.js.
const REQUEST_TYPES = {
  cost: { en: 'Costing Request' /* zh: '询价单' */ },
  sample: { en: 'Sample Request' /* zh: '样品申请' */ },
  fit_sample: { en: 'Fit Sample Request' /* zh: '试身样申请' */ },
  pp_sample: { en: 'PP Sample Request' /* zh: 'PP样衣申请' */ },
  bulk_sample: { en: 'Bulk Sample Request' /* zh: '大货样衣申请' */ },
  fabric_test: { en: 'Fabric Test Report Request' /* zh: '面料测试报告申请' */ },
};
function requestTypeLabel(type){ return (REQUEST_TYPES[type] || REQUEST_TYPES.sample).en; }

function initRequestsState(){
  if (!state.requests) state.requests = [];
  // Defaults to Awaiting on every fresh visit (including the auto-navigate
  // straight here after a send - see sendCostingEmailNow) since "what am I
  // still waiting on" is the question this view exists to answer day to day.
  if (state.requestStatusFilter === undefined) state.requestStatusFilter = 'awaiting';
  if (state.requestTypeFilter === undefined) state.requestTypeFilter = 'all';
}

async function loadRequests(){
  initRequestsState();
  const { requests } = await api('/api/requests');
  state.requests = requests;
  render();
}

function setRequestStatusFilter(filter){
  state.requestStatusFilter = filter;
  render();
}
function setRequestTypeFilter(filter){
  state.requestTypeFilter = filter;
  render();
}

function renderRequestsView(){
  initRequestsState();
  const all = state.requests;
  const awaitingCount = all.filter(r => r.status !== 'received').length;
  const receivedCount = all.filter(r => r.status === 'received').length;
  const sf = state.requestStatusFilter;
  const tf = state.requestTypeFilter;
  const filtered = all
    .filter(r => sf === 'all' || (sf === 'received' ? r.status === 'received' : r.status !== 'received'))
    .filter(r => tf === 'all' || r.request_type === tf);

  const statusTabs = [
    ['awaiting', `Awaiting (${awaitingCount})`],
    ['received', `Received (${receivedCount})`],
    ['all', `All (${all.length})`],
  ].map(([key, label]) => `<button class="btn ${sf===key?'btn-primary':'btn-ghost'} btn-sm" onclick="setRequestStatusFilter('${key}')">${label}</button>`).join(' ');

  const typeTabs = ['all', ...Object.keys(REQUEST_TYPES)].map(key => {
    const label = key === 'all' ? 'All types' : requestTypeLabel(key);
    return `<button class="btn ${tf===key?'btn-primary':'btn-ghost'} btn-sm" onclick="setRequestTypeFilter('${key}')">${label}</button>`;
  }).join(' ');

  const rows = filtered.map(r => {
    const isStyle = !r.concept_id;
    const subjectNo = isStyle ? r.style_no : r.concept_no;
    const subjectDesc = isStyle ? r.style_description : r.concept_description;
    return `
    <tr onclick="openRequestDetail(${r.id})" style="cursor:pointer;">
      <td class="name-cell">${subjectNo}${isStyle ? ' <span class="hint" style="font-weight:400;">(style)</span>' : ''}</td>
      <td>${subjectDesc || ''}</td>
      <td><span class="qr-type-badge">${requestTypeLabel(r.request_type)}</span></td>
      <td>${r.sent_to}</td>
      <td>${r.sent_by_name || ''}</td>
      <td class="mono">${new Date(r.created_at).toLocaleDateString()}</td>
      <td><span class="qr-status-badge qr-status-${r.status === 'received' ? 'received' : 'awaiting'}">${r.status === 'received' ? 'Received' : 'Awaiting'}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        ${r.status !== 'received' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); remindRequest(${r.id})">Remind${r.reminder_count ? ` (${r.reminder_count})` : ''}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); toggleRequestStatus(${r.id}, '${r.status === 'received' ? 'awaiting' : 'received'}')">
          ${r.status === 'received' ? 'Mark awaiting' : 'Mark received'}
        </button>
      </td>
    </tr>
  `;
  }).join('') || `<tr><td colspan="8"><div class="empty-state">${sf === 'awaiting' ? 'Nothing outstanding - every sent request has a reply back.' : 'No requests here yet.'}</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Requests</h1><p>${awaitingCount} awaiting${receivedCount ? `, ${receivedCount} received` : ''}</p></div>
    </div>
    <div class="filters">${statusTabs}</div>
    <div class="filters" style="margin-top:8px;">${typeTabs}</div>
    <div class="contacts-wrap">
      <table class="contacts-table">
        <thead>
          <tr><th>Concept / Style</th><th>Description</th><th>Type</th><th>Sent to</th><th>Sent by</th><th>Sent</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// Shared by both the row action button and the detail modal's button -
// updates in place rather than a full reload, so the list doesn't jump/flash.
async function toggleRequestStatus(id, newStatus){
  try {
    const { request } = await api('/api/requests/' + id + '/status', { method:'PUT', body: JSON.stringify({ status: newStatus }) });
    applyRequestUpdate(request);
    toast(newStatus === 'received' ? 'Marked as received' : 'Marked as awaiting');
    render();
  } catch(e) { toast(e.message); }
}

async function remindRequest(id){
  try {
    toast('Sending reminder...');
    const { request } = await api('/api/requests/' + id + '/remind', { method:'POST' });
    applyRequestUpdate(request);
    toast('Reminder sent to ' + request.sent_to);
    render();
  } catch(e) { toast('Could not send reminder: ' + e.message); }
}

function applyRequestUpdate(request){
  const i = state.requests.findIndex(r => r.id === request.id);
  if (i !== -1) state.requests[i] = { ...state.requests[i], ...request };
  if (state.modal && state.modal.type === 'requestDetail' && state.modal.request.id === request.id) {
    state.modal.request = { ...state.modal.request, ...request };
  }
  if (state.conceptDrawer && Array.isArray(state.conceptDrawer.requests)) {
    const j = state.conceptDrawer.requests.findIndex(r => r.id === request.id);
    if (j !== -1) state.conceptDrawer.requests[j] = { ...state.conceptDrawer.requests[j], ...request };
  }
  if (state.drawer && Array.isArray(state.drawer.requests)) {
    const k = state.drawer.requests.findIndex(r => r.id === request.id);
    if (k !== -1) state.drawer.requests[k] = { ...state.drawer.requests[k], ...request };
  }
}

// Jumps back to Concepts and opens the drawer straight on the Requests tab
// - the natural next step from either view is seeing this request in the
// context of everything else sent for that concept.
async function openConceptFromRequest(conceptId){
  closeModal();
  state.view = 'concepts';
  if (!state.concepts || !state.concepts.length) await loadConcepts();
  await openConcept(conceptId);
  state.conceptDrawer.tab = 'requests';
  await loadConceptRequests();
}

// Twin of openConceptFromRequest for a style-originated request - jumps to
// the Style board and opens that style's drawer straight on the Requests tab.
async function openStyleFromRequest(styleId){
  closeModal();
  state.view = 'dashboard';
  if (!state.styles || !state.styles.length) await loadStyles();
  await openStyle(styleId);
  state.drawer.tab = 'requests';
  render();
}

async function openRequestDetail(id){
  try {
    const { request } = await api('/api/requests/' + id);
    state.modal = { type: 'requestDetail', request };
    render();
  } catch(e) { toast(e.message); }
}

// Rendered in its own iframe (via srcdoc) rather than injected straight
// into the page - the stored HTML is a full standalone document styled for
// a blank canvas (email client), and isolating it this way means it can
// never bleed its inline styles into the surrounding app chrome, or vice
// versa.
function renderRequestDetailModal(m){
  const r = m.request;
  const received = r.status === 'received';
  const isStyle = !r.concept_id;
  const subjectNo = isStyle ? r.style_no : r.concept_no;
  const openSourceBtn = isStyle
    ? `<button class="btn btn-ghost" onclick="openStyleFromRequest(${r.style_id})">Open style</button>`
    : `<button class="btn btn-ghost" onclick="openConceptFromRequest(${r.concept_id})">Open concept</button>`;
  return `
    <div class="modal-back" onclick="if(event.target===this) closeModal()">
      <div class="modal" style="max-width:780px;width:92vw;">
        <h2>${subjectNo} &middot; ${requestTypeLabel(r.request_type)}</h2>
        <p class="hint" style="margin-bottom:4px;">Sent to ${r.sent_to} by ${r.sent_by_name || 'unknown'} on ${new Date(r.created_at).toLocaleString()}.</p>
        <p class="hint" style="margin-bottom:${(r.reminders||[]).length ? '4px' : '14px'};">
          <span class="qr-status-badge qr-status-${received ? 'received' : 'awaiting'}">${received ? 'Received' : 'Awaiting'}</span>
          ${received && r.received_at ? ` &middot; marked received ${new Date(r.received_at).toLocaleString()}` : ''}
        </p>
        ${(r.reminders||[]).length ? `
          <ul class="comment-list" style="margin-bottom:14px;">
            ${r.reminders.map(rem => `<li>Reminder sent ${new Date(rem.created_at).toLocaleString()}${rem.sent_by_name ? ' by ' + rem.sent_by_name : ''}</li>`).join('')}
          </ul>
        ` : ''}
        <iframe srcdoc="${escapeHtml(r.html)}" style="width:100%;height:52vh;border:1px solid var(--line);border-radius:var(--radius);background:#fff;"></iframe>
        <div class="row-actions" style="margin-top:14px;justify-content:space-between;">
          <div>
            ${openSourceBtn}
            ${!received ? `<button class="btn btn-ghost" onclick="remindRequest(${r.id})">Remind${r.reminder_count ? ` (${r.reminder_count})` : ''}</button>` : ''}
            <button class="btn btn-ghost" onclick="toggleRequestStatus(${r.id}, '${received ? 'awaiting' : 'received'}')">${received ? 'Mark as awaiting' : 'Mark as received'}</button>
          </div>
          <button class="btn btn-primary" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>`;
}
