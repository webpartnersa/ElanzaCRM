// ---- Single style detail + comment thread section ----
const STAGES = [
  { id:'brief', label:'Brief In' },
  { id:'doc_sent', label:'Doc Sent' },
  { id:'costed', label:'Costed' },
  { id:'worksheet', label:'Worksheet In' },
  { id:'proceed', label:'Proceed Sent' },
  { id:'po', label:'PO Confirmed' },
];
function stageLabel(id){ const s = STAGES.find(x=>x.id===id); return s ? s.label : id; }

async function openStyle(id){
  const { style, comments } = await api('/api/styles/'+id);
  state.current = { style, comments };
  state.view='detail';
  render();
}

function renderDetail(){
  const { style: s, comments } = state.current;
  const u = state.user;
  const merchFields = u.role!=='buyer' ? `
    <div><label>Cost</label>R${s.cost||'-'}</div>
    <div><label>Margin</label>${s.margin||'-'}</div>
    <div><label>Factory</label>${s.factory||'-'}</div>
  ` : '';
  const stageControl = u.role!=='buyer' ? `
    <div class="field" style="max-width:260px;margin-top:6px;">
      <label>Pipeline stage</label>
      <select id="stage-select" onchange="updateStage(${s.id}, this.value)">
        ${STAGES.map(st=>`<option value="${st.id}" ${st.id===s.stage?'selected':''}>${st.label}</option>`).join('')}
      </select>
    </div>` : '';
  return `
    <a class="back-link" onclick="goto('dashboard');">&larr; Back to pipeline</a>
    <div class="topbar"><div><h1 class="display">${s.style_no}</h1><p>${s.description||''}</p></div><span class="stage-tag">${stageLabel(s.stage)}</span></div>
    <div class="card">
      ${stageControl}
      <div class="detail-grid">
        <div><label>Retailer</label>${s.retailer}</div>
        <div><label>Department</label>${s.department}</div>
        <div><label>Buyer</label>${s.buyer||'-'}</div>
        <div><label>Target RSP</label>R${s.target_rsp||'-'}</div>
        <div><label>Fabric</label>${s.fabric||'-'}</div>
        <div><label>Colour / wash</label>${s.colour||''} ${s.wash||''}</div>
        <div><label>Units</label>${s.units||'-'}</div>
        <div><label>First ship</label>${s.first_ship||'TBC'}</div>
        ${merchFields}
      </div>
    </div>
    <div class="card" style="margin-top:14px;">
      <div style="padding-top:12px;font-weight:600;font-size:13px;">Comments</div>
      <div id="comments">
        ${comments.map(c=>`<div class="comment"><div class="who">${c.author_name} <span class="badge ${c.author_role}">${c.author_role}</span></div><div>${c.body}</div><div class="when">${new Date(c.created_at).toLocaleString()}</div></div>`).join('') || '<p style="color:var(--ink-soft);font-size:13px;">No comments yet.</p>'}
      </div>
      <div class="field" style="margin-top:14px;">
        <textarea id="new-comment" rows="3" placeholder="Add a comment..."></textarea>
      </div>
      <button class="btn btn-primary" onclick="postComment(${s.id})">Post comment</button>
    </div>`;
}

async function updateStage(styleId, newStage){
  try {
    await api('/api/styles/'+styleId, { method:'PUT', body: JSON.stringify({ stage: newStage }) });
    state.current.style.stage = newStage;
    render();
  } catch(e) {
    alert(e.message);
  }
}

async function postComment(styleId){
  const body = document.getElementById('new-comment').value.trim();
  if (!body) return;
  const { comments } = await api('/api/styles/'+styleId+'/comments', { method:'POST', body: JSON.stringify({body}) });
  state.current.comments = comments;
  render();
}
