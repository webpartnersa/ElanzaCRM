// ---- Settings: Users & Permissions (admin only) + Password (everyone) ----
async function loadUsers(){ const { users } = await api('/api/admin/users'); state.users = users; render(); }

function renderSettingsView(){
  const isAdmin = state.user.role === 'admin';
  if (state.settingsTab === undefined) state.settingsTab = isAdmin ? 'users' : 'password';
  const tab = isAdmin ? state.settingsTab : 'password';
  return `
    <div class="topbar">
      <div><h1 class="display">Settings</h1><p>${isAdmin ? 'Manage your team\'s access and your own account' : 'Manage your account'}</p></div>
    </div>
    <div class="tabs">
      ${isAdmin ? `<button class="tab ${tab==='users'?'active':''}" onclick="setSettingsTab('users')">Users &amp; Permissions</button>` : ''}
      <button class="tab ${tab==='password'?'active':''}" onclick="setSettingsTab('password')">Password</button>
    </div>
    <div style="margin-top:20px;">
      ${isAdmin && tab==='users' ? renderUsersTab() : ''}
      ${tab==='password' ? renderPasswordTab() : ''}
    </div>`;
}

function setSettingsTab(tab){
  state.settingsTab = tab;
  if (tab === 'users' && !state.users.length) loadUsers();
  else render();
}

function renderUsersTab(){
  return `
    <div class="row-actions" style="margin-bottom:14px; justify-content:flex-end;">
      <button class="btn btn-primary" onclick="state.modal='newuser'; render();">+ New user</button>
    </div>
    <div class="card">
      ${state.users.map(u=>`
        <div class="user-row">
          <div>
            <div class="user-name">${u.name} <span class="badge ${u.role}">${u.role}</span></div>
            <div class="user-meta">${u.email}${u.role==='buyer' ? ` · ${u.retailer} · ${u.department}` : ''}</div>
          </div>
          <div class="row-actions">
            <button class="btn btn-ghost btn-sm" onclick='openEditUser(${u.id})'>Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteUser(${u.id}, '${u.name.replace(/'/g,"\\'")}')">Delete</button>
          </div>
        </div>
      `).join('') || '<div class="empty-state">No users yet.</div>'}
    </div>`;
}

function renderPasswordTab(){
  return `
    <div class="card" style="max-width:420px; padding:20px;">
      <div id="cp-err" class="err hidden"></div>
      <div id="cp-ok" class="ok hidden"></div>
      <div class="field"><label>Current password</label><input id="cp-current" type="password" autocomplete="current-password"/></div>
      <div class="field"><label>New password</label><input id="cp-new" type="password" autocomplete="new-password"/></div>
      <div class="row-actions" style="margin-top:10px;">
        <button class="btn btn-primary" onclick="submitChangePw()">Update password</button>
      </div>
    </div>`;
}

async function submitChangePw(){
  const current_password = document.getElementById('cp-current').value;
  const new_password = document.getElementById('cp-new').value;
  const errEl = document.getElementById('cp-err');
  const okEl = document.getElementById('cp-ok');
  try {
    await api('/api/me/password', { method:'POST', body: JSON.stringify({current_password, new_password}) });
    okEl.textContent = 'Password updated.';
    okEl.classList.remove('hidden');
    errEl.classList.add('hidden');
    document.getElementById('cp-current').value = '';
    document.getElementById('cp-new').value = '';
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    okEl.classList.add('hidden');
  }
}

function openEditUser(id){
  const u = state.users.find(x=>x.id===id);
  state.modal = { type:'edituser', user: u };
  render();
}

async function deleteUser(id, name){
  if (!confirm(`Remove ${name}'s account? This can't be undone.`)) return;
  try { await api('/api/admin/users/'+id, { method:'DELETE' }); await loadUsers(); }
  catch(e) { alert(e.message); }
}

const PERMISSION_SECTIONS = [['styles','Styles'],['concepts','Concepts'],['shipping','Orders'],['contacts','Contacts'],['fabrics','Fabrics']];

function renderUserFormModal(u){
  const isEdit = !!u;
  // New users default to every section checked (an admin scales back from
  // there); editing shows exactly what's stored, however it got there.
  const currentPerms = isEdit ? (u.permissions||'').split(',').filter(Boolean) : PERMISSION_SECTIONS.map(s=>s[0]);
  return `
    <div class="modal-back" onclick="if(event.target===this) closeModal()">
      <div class="modal">
        <h2>${isEdit ? 'Edit user' : 'New user'}</h2>
        <div id="uf-err" class="err hidden"></div>
        <div class="field"><label>Full name</label><input id="uf-name" value="${u?u.name:''}"/></div>
        ${!isEdit ? `<div class="field"><label>Email</label><input id="uf-email" type="email" autocomplete="off"/></div>` : ''}
        <div class="field">
          <label>${isEdit ? 'Set new password (leave blank to keep current)' : 'Password'}</label>
          <input id="uf-password" type="password" autocomplete="new-password"/>
        </div>
        <div class="field">
          <label>Role</label>
          <select id="uf-role" onchange="toggleBuyerFields()">
            <option value="merchandiser" ${u&&u.role==='merchandiser'?'selected':''}>Merchandiser (full access)</option>
            <option value="admin" ${u&&u.role==='admin'?'selected':''}>Admin (full access + manage users)</option>
            <option value="buyer" ${u&&u.role==='buyer'?'selected':''}>Buyer (scoped, read-mostly)</option>
          </select>
        </div>
        <div id="uf-buyer-fields" class="${u&&u.role==='buyer'?'':'hidden'}">
          <div class="row2">
            <div class="field"><label>Retailer</label><input id="uf-retailer" value="${u&&u.retailer?u.retailer:''}" placeholder="e.g. Pick n Pay"/></div>
            <div class="field"><label>Department</label><input id="uf-department" value="${u&&u.department?u.department:''}" placeholder="e.g. Ladies"/></div>
          </div>
        </div>
        <div class="field">
          <label>Section access</label>
          <div class="hint" style="margin:-2px 0 8px;">Which parts of the portal this account can open. Cost/financial fields and edit rights are still governed by role, not this.</div>
          <div class="row-actions" style="flex-wrap:wrap; gap:16px;">
            ${PERMISSION_SECTIONS.map(([key,label])=>`
              <label style="display:flex; align-items:center; gap:6px; font-size:13.5px; font-weight:400; text-transform:none; letter-spacing:normal; cursor:pointer;">
                <input type="checkbox" id="uf-perm-${key}" style="width:auto;" ${currentPerms.includes(key)?'checked':''}/> ${label}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="row-actions" style="margin-top:10px;justify-content:flex-end;">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="submitUserForm(${isEdit ? u.id : 'null'})">${isEdit ? 'Save changes' : 'Create user'}</button>
        </div>
      </div>
    </div>`;
}

function toggleBuyerFields(){
  const role = document.getElementById('uf-role').value;
  document.getElementById('uf-buyer-fields').classList.toggle('hidden', role !== 'buyer');
}

async function submitUserForm(id){
  const name = document.getElementById('uf-name').value.trim();
  const password = document.getElementById('uf-password').value;
  const role = document.getElementById('uf-role').value;
  const retailer = document.getElementById('uf-retailer') ? document.getElementById('uf-retailer').value.trim() : '';
  const department = document.getElementById('uf-department') ? document.getElementById('uf-department').value.trim() : '';
  const permissions = PERMISSION_SECTIONS
    .map(([key]) => key)
    .filter(key => document.getElementById('uf-perm-'+key).checked);
  const errEl = document.getElementById('uf-err');
  try {
    if (id) {
      const body = { name, role, retailer, department, permissions };
      if (password) body.new_password = password;
      await api('/api/admin/users/'+id, { method:'PUT', body: JSON.stringify(body) });
    } else {
      const email = document.getElementById('uf-email').value.trim();
      await api('/api/admin/users', { method:'POST', body: JSON.stringify({name, email, password, role, retailer, department, permissions}) });
    }
    closeModal();
    await loadUsers();
  } catch(e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}
