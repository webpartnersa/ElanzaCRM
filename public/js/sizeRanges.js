// ---- Size ranges: named, ordered size sets (e.g. "S / M / L" or "S / M / L
// / XL") a concept picks one of, instead of typing sizes free-text. Loaded
// alongside concepts (see loadConcepts() in concepts.js), management UI
// lives in its own drawer opened from the Concepts topbar. ----

async function loadSizeRanges(){
  const { ranges } = await api('/api/size-ranges');
  state.sizeRanges = ranges;
  render();
}

function openSizeManager(){ state.sizeManager = true; render(); }
function closeSizeManager(){ state.sizeManager = null; render(); }

function renderSizeManagerHost(){
  if (!state.sizeManager) return `<div class="overlay" onclick="closeSizeManager()"></div><div class="drawer"></div>`;
  const ranges = state.sizeRanges || [];
  return `
    <div class="overlay open" onclick="closeSizeManager()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>Manage Size Ranges</h2>
        <button class="drawer-close" onclick="closeSizeManager()">&times;</button>
      </div>
      <div class="drawer-body">
        ${ranges.length ? `
          <div class="test-report-list">
            ${ranges.map(r => `
              <div class="test-report-row">
                <div class="mono" style="font-weight:600;">${r.values.join(' / ')}</div>
                <button class="btn btn-ghost btn-sm" onclick="deleteSizeRange(${r.id})">Delete</button>
              </div>
            `).join('')}
          </div>
        ` : `<div class="hint">No size ranges yet.</div>`}
        <div class="field" style="margin-top:16px;">
          <label>New size range (comma separated, in order)</label>
          <input id="new-size-range-input" placeholder="e.g. S, M, L, XL"/>
        </div>
        <button class="btn btn-primary btn-sm" onclick="addSizeRange()">+ Add size range</button>
      </div>
    </div>`;
}

function addSizeRange(){
  const el = document.getElementById('new-size-range-input');
  const values = el.value.split(',').map(v=>v.trim()).filter(Boolean);
  if (!values.length) { toast('Enter at least one size value'); return; }
  api('/api/size-ranges', { method:'POST', body: JSON.stringify({ values }) })
    .then(() => { el.value = ''; return loadSizeRanges(); })
    .catch(e => toast(e.message));
}
function deleteSizeRange(id){
  if (!confirm('Delete this size range? Any concept using it will have its sizes cleared.')) return;
  api('/api/size-ranges/'+id, { method:'DELETE' })
    .then(async () => { await loadSizeRanges(); await loadConcepts(); })
    .catch(e => toast(e.message));
}
