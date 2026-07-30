// ---- Styles pipeline (dashboard/list section) ----
async function loadStyles(){ const { styles } = await api('/api/styles'); state.styles = styles; render(); }

function renderDashboard(){
  return `
    <div class="topbar"><div><h1 class="display">Style pipeline</h1><p>${state.styles.length} style${state.styles.length===1?'':'s'}</p></div></div>
    <div class="card">
      ${state.styles.map(s=>`
        <div class="style-row" onclick="openStyle(${s.id})">
          <div><div class="style-name">${s.style_no} — ${s.description||''}</div><div class="style-meta">${s.retailer} · ${s.department}</div></div>
          <span class="stage-tag">${stageLabel(s.stage)}</span>
        </div>
      `).join('') || '<div class="empty-state">No styles yet.</div>'}
    </div>`;
}
