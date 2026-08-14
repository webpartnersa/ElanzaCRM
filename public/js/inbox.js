// ---- Inbound Email Inbox (real) ----
// Same UX validated in the Phase 4 mock (public/js/inboxDemo.js, now
// removed) - list + status badges, expand-to-review, per-linked-record
// Apply/Decline/Apply all/Decline all, multi-candidate picking, manual
// search+link, Dismiss - but backed by the real API (routes/inbox.js) over
// inbound_emails / inbound_email_field_changes instead of hand-written
// sample data.
function initInboxState(){
  if (!state.inbox) state.inbox = { emails: null, expandedId: null, detail: null, searchQuery: {}, searchResults: {}, showFullBody: {}, loading: false };
}

async function loadInboxEmails(){
  initInboxState();
  state.inbox.loading = true;
  render();
  try {
    const { emails } = await api('/api/inbox/emails');
    state.inbox.emails = emails;
  } catch (e) {
    toast(e.message);
    state.inbox.emails = [];
  }
  state.inbox.loading = false;
  render();
}

async function toggleInboxItem(id){
  initInboxState();
  if (state.inbox.expandedId === id) {
    state.inbox.expandedId = null;
    state.inbox.detail = null;
    render();
    return;
  }
  state.inbox.expandedId = id;
  state.inbox.detail = null;
  render();
  try {
    state.inbox.detail = await api('/api/inbox/emails/' + id);
  } catch (e) {
    toast(e.message);
    state.inbox.expandedId = null;
  }
  render();
}

// After any mutating action: re-fetch the list (counts/badges may have
// changed) and, if the email is still expanded, its detail too - a 404
// there means Apply/Decline/Dismiss just fully resolved and removed it.
async function refreshInboxAfterAction(emailId){
  const { emails } = await api('/api/inbox/emails').catch(() => ({ emails: state.inbox.emails }));
  state.inbox.emails = emails;
  if (state.inbox.expandedId === emailId) {
    try {
      state.inbox.detail = await api('/api/inbox/emails/' + emailId);
    } catch (e) {
      state.inbox.expandedId = null;
      state.inbox.detail = null;
    }
  }
  render();
}

async function inboxApplyChange(emailId, changeId){
  try {
    await api('/api/inbox/field-changes/' + changeId + '/apply', { method: 'POST' });
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}
async function inboxDeclineChange(emailId, changeId){
  try {
    await api('/api/inbox/field-changes/' + changeId + '/decline', { method: 'POST' });
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}
async function inboxApplyAll(emailId, recordType, recordId){
  try {
    await api('/api/inbox/emails/' + emailId + '/apply-all', { method: 'POST', body: JSON.stringify({ record_type: recordType, record_id: recordId }) });
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}
async function inboxDeclineAll(emailId, recordType, recordId){
  try {
    await api('/api/inbox/emails/' + emailId + '/decline-all', { method: 'POST', body: JSON.stringify({ record_type: recordType, record_id: recordId }) });
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}
async function inboxResolve(emailId, recordType, recordId){
  try {
    await api('/api/inbox/emails/' + emailId + '/resolve', { method: 'POST', body: JSON.stringify({ record_type: recordType, record_id: recordId }) });
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}
async function inboxDismiss(emailId){
  try {
    await api('/api/inbox/emails/' + emailId + '/dismiss', { method: 'POST' });
    state.inbox.expandedId = null;
    state.inbox.detail = null;
    await refreshInboxAfterAction(emailId);
  } catch (e) { toast(e.message); }
}

let inboxSearchDebounce = null;
function inboxSetSearchQuery(emailId, q){
  initInboxState();
  state.inbox.searchQuery[emailId] = q;
  render();
  const el = document.getElementById('inbox-search-' + emailId);
  if (el) {
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }
  clearTimeout(inboxSearchDebounce);
  inboxSearchDebounce = setTimeout(async () => {
    const query = (state.inbox.searchQuery[emailId] || '').trim();
    if (!query) { state.inbox.searchResults[emailId] = []; render(); return; }
    try {
      const { results } = await api('/api/inbox/search?q=' + encodeURIComponent(query));
      state.inbox.searchResults[emailId] = results;
    } catch (e) {
      state.inbox.searchResults[emailId] = [];
    }
    render();
    const el2 = document.getElementById('inbox-search-' + emailId);
    if (el2) { el2.focus(); const len2 = el2.value.length; el2.setSelectionRange(len2, len2); }
  }, 250);
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

// received_at is stored/sent as UTC (Resend's own timestamp) - the droplet
// itself stays on UTC on purpose (avoids DST/log-ordering headaches
// server-side), so conversion to the viewer's own local time belongs here,
// same toLocaleString() convention already used for created_at elsewhere
// in this app (see public/js/requests.js, drawer.js).
function formatInboxDate(receivedAt){
  if (!receivedAt) return '';
  const d = new Date(receivedAt);
  return isNaN(d.getTime()) ? receivedAt : d.toLocaleString();
}

function renderInboxView(){
  initInboxState();
  if (state.inbox.emails === null && !state.inbox.loading) loadInboxEmails();
  const emails = state.inbox.emails || [];
  const matchedCount = emails.filter(e => e.match_status === 'matched').length;
  const multipleCount = emails.filter(e => e.match_status === 'multiple').length;
  const unmatchedCount = emails.filter(e => e.match_status === 'unmatched').length;
  return `
    <div class="topbar">
      <div><h1 class="display">Inbox</h1><p>AI-matched mail from crm@portal.elanzas.com</p></div>
      <div class="row-actions"><button class="btn btn-ghost" onclick="loadInboxEmails()">Refresh</button></div>
    </div>
    ${state.inbox.loading && state.inbox.emails === null ? `<div class="hint">Loading...</div>` : ''}
    ${state.inbox.emails !== null ? `
      <div class="hint" style="margin-bottom:14px;">${matchedCount} matched &middot; ${multipleCount} need a pick &middot; ${unmatchedCount} unmatched</div>
      ${emails.length ? emails.map(renderInboxRow).join('') : `<div class="hint">Nothing in the inbox right now.</div>`}
    ` : ''}
  `;
}

function renderInboxRow(item){
  const expanded = state.inbox.expandedId === item.id;
  const linkedSummary = item.linked_records.map(r => `${MATCH_TYPE_LABEL[r.type]} ${r.no}`).join(', ');
  return `
    <div class="card" style="padding:0;margin-bottom:12px;overflow:hidden;">
      <div style="padding:14px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;" onclick="toggleInboxItem(${item.id})">
        <div style="min-width:0;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="style-name" style="font-size:14.5px;">${escapeHtml(item.subject || '(no subject)')}</span>
            ${INBOX_STATUS_BADGE[item.match_status] || ''}
            ${linkedSummary ? `<span class="hint">${escapeHtml(linkedSummary)}</span>` : ''}
          </div>
          <div class="hint" style="margin-top:3px;">${escapeHtml(item.from_name || item.from_email || '')} &lt;${escapeHtml(item.from_email || '')}&gt; &middot; ${formatInboxDate(item.received_at)}</div>
        </div>
        <div class="hint" style="flex-shrink:0;">${expanded ? '▲' : '▼'}</div>
      </div>
      ${expanded ? renderInboxDetail(item.id) : ''}
    </div>
  `;
}

function inboxToggleFullBody(emailId){
  initInboxState();
  if (!state.inbox.showFullBody) state.inbox.showFullBody = {};
  state.inbox.showFullBody[emailId] = !state.inbox.showFullBody[emailId];
  render();
}

function renderInboxDetail(emailId){
  const d = state.inbox.detail;
  if (!d || d.id !== emailId) return `<div style="border-top:1px solid var(--line);padding:16px 18px;" class="hint">Loading...</div>`;
  const hasKeyPoints = Array.isArray(d.key_points) && d.key_points.length > 0;
  const showFull = !hasKeyPoints || (state.inbox.showFullBody && state.inbox.showFullBody[emailId]);
  return `
    <div style="border-top:1px solid var(--line);padding:16px 18px;background:var(--line-soft);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;">
        <div style="background:var(--paper-raised);border:1px solid var(--line);border-radius:var(--radius);padding:12px 14px;flex:1;">
          ${showFull ? `
            <div style="white-space:pre-wrap;font-size:13.5px;">${escapeHtml(d.body || '(no body)')}</div>
          ` : `
            <ul style="margin:0;padding-left:18px;font-size:13.5px;">
              ${d.key_points.map(p => `<li style="margin-bottom:4px;">${escapeHtml(p)}</li>`).join('')}
            </ul>
          `}
          ${hasKeyPoints ? `<a href="#" onclick="inboxToggleFullBody(${d.id});return false;" style="font-size:12px;display:inline-block;margin-top:8px;">${showFull ? 'Show summary' : 'Show full email'}</a>` : ''}
        </div>
        <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;flex-shrink:0;" title="Nothing here worth acting on - clear it without applying anything" onclick="inboxDismiss(${d.id})">Dismiss</button>
      </div>
      ${d.linked_records.map(r => renderInboxRecordChanges(d.id, r)).join('')}
      ${d.unlinked_candidates.length ? renderInboxCandidates(d.id, d.unlinked_candidates, d.linked_records.length > 0) : ''}
      ${!d.linked_records.length && !d.unlinked_candidates.length ? renderInboxSearchBox(d.id) : ''}
    </div>
  `;
}

function renderInboxRecordChanges(emailId, record){
  const pendingCount = record.changes.filter(c => c.status === 'pending').length;
  return `
    <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div style="font-size:13px;font-weight:600;">${record.changes.length ? 'Proposed changes' : 'Linked'} - ${MATCH_TYPE_LABEL[record.type]} ${escapeHtml(record.no || '')} <span class="hint" style="font-weight:400;">${escapeHtml(record.description || '')}</span></div>
        ${pendingCount > 1 ? `
          <div class="row-actions">
            <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px;" onclick="inboxApplyAll(${emailId},'${record.type}',${record.id})">Apply all</button>
            <button class="btn btn-danger" style="padding:6px 12px;font-size:12px;" onclick="inboxDeclineAll(${emailId},'${record.type}',${record.id})">Decline all</button>
          </div>` : ''}
      </div>
      ${!record.changes.length ? `<div class="hint">No field changes proposed for this record.</div>` : record.changes.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:1px solid var(--line);${CHANGE_STATUS_STYLE[c.status]}">
          <div style="min-width:0;flex:1;">
            <div style="font-size:13px;font-weight:600;">${escapeHtml(c.field_label || c.field_name)}</div>
            <div style="font-size:13px;margin-top:2px;">
              <span style="color:var(--ink-soft);">${escapeHtml(c.current_value || '—')}</span>
              <span style="margin:0 6px;">&rarr;</span>
              <strong>${escapeHtml(c.proposed_value)}</strong>
            </div>
            ${c.source_snippet ? `<div class="hint" style="margin-top:4px;font-style:italic;">"${escapeHtml(c.source_snippet)}"</div>` : ''}
          </div>
          <div style="flex-shrink:0;">
            ${c.status === 'pending' ? `
              <div class="row-actions">
                <button class="btn btn-ghost" style="padding:5px 11px;font-size:12px;" onclick="inboxApplyChange(${emailId},${c.id})">Apply</button>
                <button class="btn btn-danger" style="padding:5px 11px;font-size:12px;" onclick="inboxDeclineChange(${emailId},${c.id})">Decline</button>
              </div>
            ` : `<span class="hint" style="font-weight:600;">${c.status === 'applied' ? '✓ Applied' : '✕ Declined'}</span>`}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderInboxCandidates(emailId, candidates, hasLinked){
  return `
    <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--line);">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px;">${hasLinked ? 'Also worth checking - this email may cover more than one record' : 'Which record is this about?'}</div>
      ${candidates.map(c => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--paper-raised);">
          <div><span class="hint">${MATCH_TYPE_LABEL[c.type]}</span> <strong>${escapeHtml(c.no || '')}</strong> &middot; ${escapeHtml(c.label || '')}</div>
          <button class="btn btn-primary" style="padding:6px 14px;font-size:12px;" onclick="inboxResolve(${emailId},'${c.type}',${c.id})">Use this</button>
        </div>
      `).join('')}
    </div>
  `;
}

function renderInboxSearchBox(emailId){
  initInboxState();
  const q = (state.inbox.searchQuery[emailId] || '').trim();
  const results = state.inbox.searchResults[emailId] || [];
  return `
    <div style="font-size:13px;font-weight:600;margin-bottom:8px;">Search to link a record manually</div>
    <input id="inbox-search-${emailId}" placeholder="Search by style/concept/order number or description..." value="${escapeHtml(q)}"
      oninput="inboxSetSearchQuery(${emailId}, this.value)" style="width:100%;margin-bottom:10px;" />
    ${q && !results.length ? `<div class="hint">No matches for "${escapeHtml(q)}"</div>` : ''}
    ${results.map(r => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--line);border-radius:var(--radius);margin-bottom:8px;background:var(--paper-raised);">
        <div><span class="hint">${MATCH_TYPE_LABEL[r.type]}</span> <strong>${escapeHtml(r.no || '')}</strong> &middot; ${escapeHtml(r.description || '')}</div>
        <button class="btn btn-primary" style="padding:6px 14px;font-size:12px;" onclick="inboxResolve(${emailId},'${r.type}',${r.id})">Link</button>
      </div>
    `).join('')}
  `;
}
