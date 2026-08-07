// ---- Shared modal dispatcher ----
function renderModal(){
  if (state.modal === 'newuser') return renderUserFormModal(null);
  if (state.modal && state.modal.type === 'edituser') return renderUserFormModal(state.modal.user);
  if (state.modal && state.modal.type === 'shipDelay') return renderShipDelayModal(state.modal);
  if (state.modal && state.modal.type === 'duplicateStyle') return renderDuplicateStyleModal(state.modal);
  if (state.modal && state.modal.type === 'requestDetail') return renderRequestDetailModal(state.modal);
  return '';
}

// Prompts for the one thing a duplicate can't inherit from its source -
// a style number has to be unique, so it can't just be copied verbatim.
function renderDuplicateStyleModal(m){
  return `
    <div class="modal-back" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h2>Duplicate ${m.sourceStyleNo}</h2>
        <p class="hint" style="margin-bottom:14px;">Copies the buyer brief, tech spec, worksheet and photos to a new style - pick its style number.</p>
        <div class="field">
          <label>New style number</label>
          <input id="duplicate-style-no" placeholder="e.g. ${m.sourceStyleNo}-2" ${m.error ? 'autofocus' : ''}/>
        </div>
        ${m.error ? `<div class="error-msg" style="color:var(--stitch-red);font-size:12.5px;margin-top:8px;">${m.error}</div>` : ''}
        <div class="row-actions" style="margin-top:14px;justify-content:flex-end;">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" ${m.busy?'disabled':''} onclick="submitDuplicateStyle()">${m.busy ? 'Duplicating...' : 'Duplicate'}</button>
        </div>
      </div>
    </div>`;
}

async function submitDuplicateStyle(){
  const m = state.modal;
  const styleNo = document.getElementById('duplicate-style-no').value.trim();
  if (!styleNo) { toast('Enter a style number'); return; }
  m.busy = true; m.error = '';
  render();
  try {
    const { style } = await api('/api/styles/'+m.sourceId+'/duplicate', { method:'POST', body: JSON.stringify({ style_no: styleNo }) });
    closeModal();
    await loadStyles();
    openStyle(style.id);
    toast(`${style.style_no} created`);
  } catch (e) {
    m.busy = false;
    m.error = e.message;
    render();
  }
}

// Required before an already-set shipment date can be pushed out - see
// onShippingDateBlur in shipping.js for when this fires vs a plain save.
function renderShipDelayModal(m){
  return `
    <div class="modal-back" onclick="if(event.target===this) cancelShipDelay()">
      <div class="modal">
        <h2>Why is the shipment date moving?</h2>
        <p class="hint" style="margin-bottom:14px;">${formatShipDateShort(m.oldDate)} &rarr; ${formatShipDateShort(m.newDate)}</p>
        <div class="field"><label>Reason</label><textarea id="delay-reason" rows="3" placeholder="e.g. Factory delayed on fabric approval"></textarea></div>
        <div class="row-actions" style="margin-top:14px;justify-content:flex-end;">
          <button class="btn btn-ghost" onclick="cancelShipDelay()">Cancel</button>
          <button class="btn btn-primary" onclick="submitShipDelay()">Save</button>
        </div>
      </div>
    </div>`;
}

function closeModal(){ state.modal = null; render(); }
