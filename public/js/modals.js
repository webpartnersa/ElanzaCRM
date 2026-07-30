// ---- Shared modal dispatcher ----
function renderModal(){
  if (state.modal === 'newuser') return renderUserFormModal(null);
  if (state.modal && state.modal.type === 'edituser') return renderUserFormModal(state.modal.user);
  if (state.modal && state.modal.type === 'shipDelay') return renderShipDelayModal(state.modal);
  return '';
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
