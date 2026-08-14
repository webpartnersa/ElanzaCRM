// ---- Inbound Email Inbox (PROTOTYPE) ----
// Phase 4 of the AI inbound email project: mock/fake data only, nothing
// here reads from or writes to inbound_emails / inbound_email_field_changes
// or any real concept/style/order - built purely to validate the review
// UX (list + status badges, expand-to-review, apply/decline) before wiring
// real data in Phase 5. Every interaction below mutates the DEMO_INBOX
// array in place and re-renders, so it's genuinely clickable, not a static
// mockup - delete this file + its nav entry once a decision is made, same
// as tasksDemo.js.
//
// The three statuses mirror the real backend's own three outcomes (see
// lib/emailMatch.js): 'matched' (single confident match - green),
// 'multiple' (a few candidates, needs a human pick - amber), 'unmatched'
// (needs a manual search/link - gray).
let DEMO_INBOX = [
  {
    id: 1, status: 'matched',
    from_name: 'Wofeng Sourcing', from_email: 'sourcing@wofeng-example.com',
    subject: 'RE: SAMPLE-EYB001 costing confirmation',
    received_at: '2026-08-14 09:12',
    body: `Hi, confirming for SAMPLE-EYB001: final unit cost is now $54.50 (up from the original quote due to fleece price increase), and we will need to switch fabric to 100% Organic Cotton Fleece since the standard cotton fleece is out of stock at our mill. Units and delivery date remain unchanged.\n\nThanks,\nWofeng Sourcing`,
    match: { type: 'style', no: 'SAMPLE-EYB001', label: 'Boys Fleece Hoodie' },
    changes: [
      { id: 1, field_label: 'Cost', current: '52.30', proposed: '54.50', snippet: 'final unit cost is now $54.50 (up from the original quote due to fleece price increase)', status: 'pending' },
      { id: 2, field_label: 'Fabric', current: '100% Cotton Fleece', proposed: '100% Organic Cotton Fleece', snippet: 'we will need to switch fabric to 100% Organic Cotton Fleece since the standard cotton fleece is out of stock at our mill', status: 'pending' },
    ],
  },
  {
    id: 2, status: 'matched',
    from_name: 'Wofeng Sourcing', from_email: 'sourcing@wofeng-example.com',
    subject: 'RE: SAMPLE-PO-1002 delivery update',
    received_at: '2026-08-14 10:47',
    body: `Apologies, the PO delivery date for SAMPLE-PO-1002 will slip to 2026-10-05 due to a container booking delay. PO price stays at $34.10 as agreed.\n\nRegards`,
    match: { type: 'order', no: 'SAMPLE-PO-1002', label: 'Older Boys Joggers' },
    changes: [
      { id: 3, field_label: 'PO Delivery Date', current: '2026-09-20', proposed: '2026-10-05', snippet: 'the PO delivery date for SAMPLE-PO-1002 will slip to 2026-10-05 due to a container booking delay', status: 'pending' },
    ],
  },
  {
    id: 3, status: 'matched',
    from_name: 'Wofeng Sourcing', from_email: 'sourcing@wofeng-example.com',
    subject: 'RE: CYB002 lead time',
    received_at: '2026-08-13 15:20',
    body: `For CYB002 (pinstripes denim jacket), lead time from PO to ex-factory will be 75 days given the current order book. No change to factory.\n\nThanks`,
    match: { type: 'concept', no: 'CYB002', label: 'pinstripes denim jacket' },
    changes: [
      { id: 4, field_label: 'Lead Time', current: '—', proposed: '75 days given the current order book', snippet: 'lead time from PO to ex-factory will be 75 days given the current order book', status: 'applied' },
    ],
  },
  {
    id: 4, status: 'multiple',
    from_name: 'Wofeng Sourcing', from_email: 'sourcing@wofeng-example.com',
    subject: 'Update on a couple of styles',
    received_at: '2026-08-14 08:03',
    body: `Quick update: SAMPLE-EYB001 fabric is in, and separately SAMPLE-PEOB001 samples shipped yesterday.\n\nLet us know if you need anything else.`,
    candidates: [
      { type: 'style', no: 'SAMPLE-EYB001', label: 'Boys Fleece Hoodie' },
      { type: 'style', no: 'SAMPLE-PEOB001', label: 'Older Boys Joggers' },
    ],
    changesIfPicked: [
      { id: 5, field_label: 'Fabric', current: '100% Cotton Fleece', proposed: 'Received / in stock', snippet: 'SAMPLE-EYB001 fabric is in', status: 'pending' },
    ],
  },
  {
    id: 5, status: 'unmatched',
    from_name: 'PnP Buying Team', from_email: 'buyer@pnp-example.co.za',
    subject: 'Quick question about delivery timing',
    received_at: '2026-08-14 11:30',
    body: `Hi team, just checking on general delivery timing for the upcoming season - can someone give me a call when you have a moment?\n\nThanks`,
  },
  {
    id: 6, status: 'unmatched',
    from_name: 'New Supplier', from_email: 'hello@newsupplier-example.com',
    subject: 'Introducing our new fabric range',
    received_at: '2026-08-13 14:05',
    body: `Hello, we would like to introduce our new range of sustainable fabrics for your upcoming collections. Happy to send swatches on request.\n\nBest regards`,
  },
];

// Small stand-in for a real search-by-style/concept/order-number endpoint -
// mixes the real CYB002/PB005 concepts in with the sample styles/orders so
// the search box has something plausible to filter against.
const DEMO_SEARCH_INDEX = [
  { type: 'concept', no: 'CYB002', label: 'pinstripes denim jacket' },
  { type: 'concept', no: 'PB005', label: 'Concept PB005' },
  { type: 'style', no: 'SAMPLE-PL001', label: 'Ladies Rugby Top' },
  { type: 'style', no: 'SAMPLE-EYB001', label: 'Boys Fleece Hoodie' },
  { type: 'style', no: 'SAMPLE-PEOB001', label: 'Older Boys Joggers' },
  { type: 'style', no: 'SAMPLE-PYG001', label: 'Girls Denim Jacket' },
  { type: 'order', no: 'SAMPLE-PO-1001', label: 'Boys Fleece Hoodie' },
  { type: 'order', no: 'SAMPLE-PO-1002', label: 'Older Boys Joggers' },
  { type: 'order', no: 'SAMPLE-PO-1003', label: 'Girls Denim Jacket' },
];

function initInboxDemoState(){
  if (!state.inboxDemo) state.inboxDemo = { expandedId: null, searchQuery: {} };
}
function toggleInboxItem(id){
  initInboxDemoState();
  state.inboxDemo.expandedId = state.inboxDemo.expandedId === id ? null : id;
  render();
}
function findInboxItem(id){ return DEMO_INBOX.find(e => e.id === id); }

// Product decision (confirmed with the user): once every proposed change on
// a matched email has been resolved (applied or declined, none left
// pending), the email is removed outright - no "resolved" archive to look
// back at, same as clearing a real inbox. Mirrors lib/emailApply.js's
// cleanupIfFullyResolved exactly, including the "never on a freshly
// matched/linked email with zero changes" guard (see inboxPickCandidate/
// inboxLinkRecord below, which don't call this).
function maybeRemoveResolved(emailId){
  const item = findInboxItem(emailId);
  if (!item || !item.changes || !item.changes.length) return;
  if (item.changes.some(c => c.status === 'pending')) return;
  DEMO_INBOX = DEMO_INBOX.filter(e => e.id !== emailId);
  if (state.inboxDemo.expandedId === emailId) state.inboxDemo.expandedId = null;
}

function inboxApplyChange(emailId, changeId){
  const item = findInboxItem(emailId);
  const change = item.changes.find(c => c.id === changeId);
  change.status = 'applied';
  maybeRemoveResolved(emailId);
  render();
}
function inboxDeclineChange(emailId, changeId){
  const item = findInboxItem(emailId);
  const change = item.changes.find(c => c.id === changeId);
  change.status = 'declined';
  maybeRemoveResolved(emailId);
  render();
}
function inboxApplyAll(emailId){
  const item = findInboxItem(emailId);
  item.changes.filter(c => c.status === 'pending').forEach(c => c.status = 'applied');
  maybeRemoveResolved(emailId);
  render();
}
function inboxDeclineAll(emailId){
  const item = findInboxItem(emailId);
  item.changes.filter(c => c.status === 'pending').forEach(c => c.status = 'declined');
  maybeRemoveResolved(emailId);
  render();
}
function inboxPickCandidate(emailId, idx){
  const item = findInboxItem(emailId);
  const picked = item.candidates[idx];
  item.status = 'matched';
  item.match = picked;
  item.changes = (item.changesIfPicked || []).map(c => ({...c}));
  delete item.candidates;
  delete item.changesIfPicked;
  render();
}
function inboxSetSearchQuery(emailId, q){
  initInboxDemoState();
  state.inboxDemo.searchQuery[emailId] = q;
  render();
  const el = document.getElementById('inbox-search-' + emailId);
  if (el) {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
}
function inboxLinkRecord(emailId, no){
  const item = findInboxItem(emailId);
  const record = DEMO_SEARCH_INDEX.find(r => r.no === no);
  item.status = 'matched';
  item.match = record;
  item.changes = []; // a manual link has no AI-proposed changes yet in this mock - a real Phase 5 would re-run extraction once linked
  render();
}

const INBOX_BADGE_STYLE = 'display:inline-block;font-size:9pt;font-weight:600;padding:2px 9px;border-radius:9px;white-space:nowrap;';
const INBOX_STATUS_BADGE = {
  matched: `<span style="${INBOX_BADGE_STYLE}background:#E5F3EA;color:#1E7A3D;">Matched</span>`,
  multiple: `<span style="${INBOX_BADGE_STYLE}background:#FFF3D6;color:#8A6116;">Multiple candidates</span>`,
  unmatched: `<span style="${INBOX_BADGE_STYLE}background:#EEF1F5;color:#556;">Unmatched</span>`,
};
const CHANGE_STATUS_STYLE = {
  pending: '',
  applied: 'opacity:0.55;',
  declined: 'opacity:0.55;text-decoration:line-through;',
};
const MATCH_TYPE_LABEL = { concept: 'Concept', style: 'Style', order: 'Order' };

function renderInboxDemoView(){
  initInboxDemoState();
  const matchedCount = DEMO_INBOX.filter(e => e.status === 'matched').length;
  const multipleCount = DEMO_INBOX.filter(e => e.status === 'multiple').length;
  const unmatchedCount = DEMO_INBOX.filter(e => e.status === 'unmatched').length;
  return `
    <div class="topbar">
      <div><h1 class="display">Inbox</h1><p>Prototype - AI-matched inbound mail, not live data</p></div>
    </div>
    <div class="hint" style="margin-bottom:16px;background:#FFF6E0;padding:10px;border-radius:var(--radius);">
      PROTOTYPE - every email below is hand-written sample content, not a real inbound message (real mail isn't landing yet, pending Resend's own investigation). Built to review this UX before wiring it to real inbound_emails data. Click a row to expand it, then try Apply/Decline.
    </div>
    <div class="hint" style="margin-bottom:14px;">${matchedCount} matched &middot; ${multipleCount} need a pick &middot; ${unmatchedCount} unmatched</div>
    ${DEMO_INBOX.map(renderInboxRow).join('')}
  `;
}

function renderInboxRow(item){
  const expanded = state.inboxDemo.expandedId === item.id;
  return `
    <div class="card" style="padding:0;margin-bottom:12px;overflow:hidden;">
      <div style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;" onclick="toggleInboxItem(${item.id})">
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="style-name" style="font-size:14.5px;">${item.subject}</span>
            ${INBOX_STATUS_BADGE[item.status]}
            ${item.match ? `<span class="hint">${MATCH_TYPE_LABEL[item.match.type]} ${item.match.no}</span>` : ''}
          </div>
          <div class="hint" style="margin-top:3px;">${item.from_name} &lt;${item.from_email}&gt; &middot; ${item.received_at}</div>
        </div>
        <div class="hint" style="flex-shrink:0;">${expanded ? '▲' : '▼'}</div>
      </div>
      ${expanded ? renderInboxDetail(item) : ''}
    </div>
  `;
}

function renderInboxDetail(item){
  return `
    <div style="border-top:1px solid var(--line);padding:16px 18px;background:var(--line-soft);">
      <div style="white-space:pre-wrap;font-size:13.5px;background:var(--paper-raised);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;margin-bottom:14px;">${item.body}</div>
      ${item.status === 'matched' ? renderInboxChanges(item) : ''}
      ${item.status === 'multiple' ? renderInboxCandidates(item) : ''}
      ${item.status === 'unmatched' ? renderInboxSearchBox(item) : ''}
    </div>
  `;
}

function renderInboxChanges(item){
  const pendingCount = item.changes.filter(c => c.status === 'pending').length;
  if (!item.changes.length) {
    return `<div class="hint">No field changes proposed for this email.</div>`;
  }
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:13px;font-weight:600;">Proposed changes - ${MATCH_TYPE_LABEL[item.match.type]} ${item.match.no}</div>
      ${pendingCount > 1 ? `
        <div class="row-actions">
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="inboxApplyAll(${item.id})">Apply all</button>
          <button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" onclick="inboxDeclineAll(${item.id})">Decline all</button>
        </div>` : ''}
    </div>
    ${item.changes.map(c => `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);${CHANGE_STATUS_STYLE[c.status]}">
        <div style="min-width:0;flex:1;">
          <div style="font-size:13px;font-weight:600;">${c.field_label}</div>
          <div style="font-size:13px;margin-top:2px;">
            <span style="color:var(--ink-soft);">${c.current || '—'}</span>
            <span style="margin:0 6px;">&rarr;</span>
            <strong>${c.proposed}</strong>
          </div>
          <div class="hint" style="margin-top:4px;font-style:italic;">"${c.snippet}"</div>
        </div>
        <div style="flex-shrink:0;">
          ${c.status === 'pending' ? `
            <div class="row-actions">
              <button class="btn btn-ghost" style="padding:5px 11px;font-size:12px;" onclick="inboxApplyChange(${item.id},${c.id})">Apply</button>
              <button class="btn btn-danger" style="padding:5px 11px;font-size:12px;" onclick="inboxDeclineChange(${item.id},${c.id})">Decline</button>
            </div>
          ` : `<span class="hint" style="font-weight:600;">${c.status === 'applied' ? '✓ Applied' : '✕ Declined'}</span>`}
        </div>
      </div>
    `).join('')}
  `;
}

function renderInboxCandidates(item){
  return `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Which record is this about?</div>
    ${item.candidates.map((c, idx) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--paper-raised);">
        <div><span class="hint">${MATCH_TYPE_LABEL[c.type]}</span> <strong>${c.no}</strong> &middot; ${c.label}</div>
        <button class="btn btn-primary" style="padding:6px 14px;font-size:12px;" onclick="inboxPickCandidate(${item.id},${idx})">Use this</button>
      </div>
    `).join('')}
  `;
}

function renderInboxSearchBox(item){
  const q = (state.inboxDemo.searchQuery[item.id] || '').trim();
  const needle = q.toLowerCase();
  const results = needle ? DEMO_SEARCH_INDEX.filter(r => r.no.toLowerCase().includes(needle) || r.label.toLowerCase().includes(needle)).slice(0, 6) : [];
  return `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Search to link a record manually</div>
    <input id="inbox-search-${item.id}" placeholder="Search by style/concept/order number or description..." value="${q}"
      oninput="inboxSetSearchQuery(${item.id}, this.value)" style="width:100%;margin-bottom:10px;" />
    ${q && !results.length ? `<div class="hint">No matches for "${q}"</div>` : ''}
    ${results.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--paper-raised);">
        <div><span class="hint">${MATCH_TYPE_LABEL[r.type]}</span> <strong>${r.no}</strong> &middot; ${r.label}</div>
        <button class="btn btn-primary" style="padding:6px 14px;font-size:12px;" onclick="inboxLinkRecord(${item.id},'${r.no}')">Link</button>
      </div>
    `).join('')}
  `;
}
