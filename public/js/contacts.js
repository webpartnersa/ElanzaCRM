// ---- Contacts: buyers/planners/QC/other contacts per retailer+department.
// Ported from reference-contacts-demo.html. Feeds the Buyer auto-fill on the
// New Style drawer (see drawer.js) - a convenience layer only, styles.buyer
// stays a free-text column with no foreign key into this table.

const CONTACT_POSITIONS = ['Buyer', 'Planner', 'QC', 'Other'];

function initContactsState(){
  if (!state.contacts) state.contacts = [];
  if (!state.contactFilters) state.contactFilters = { retailer:'', department:'', position:'' };
  if (state.contactDrawer === undefined) state.contactDrawer = null;
}

async function loadContacts(){
  initContactsState();
  const { contacts } = await api('/api/contacts');
  state.contacts = contacts;
  render();
}

function setContactFilter(key, val){ state.contactFilters[key] = val; render(); }

function positionBadgeClass(p){ return 'position-' + (p||'other').toLowerCase(); }

function renderContactsView(){
  initContactsState();
  const f = state.contactFilters;
  const filtered = state.contacts.filter(c =>
    (!f.retailer || c.retailer===f.retailer) &&
    (!f.department || c.department===f.department) &&
    (!f.position || c.position===f.position)
  );
  const retailerOpts = RETAILERS.map(r=>`<option value="${r}" ${f.retailer===r?'selected':''}>${r}</option>`).join('');
  const deptOpts = DEPARTMENTS.map(d=>`<option value="${d}" ${f.department===d?'selected':''}>${d}</option>`).join('');
  const posOpts = CONTACT_POSITIONS.map(p=>`<option value="${p}" ${f.position===p?'selected':''}>${p}</option>`).join('');

  const rows = filtered.slice().sort((a,b)=>(a.last_name||'').localeCompare(b.last_name||'')).map(c=>`
    <tr>
      <td class="name-cell">${c.first_name} ${c.last_name}</td>
      <td><span class="position-badge ${positionBadgeClass(c.position)}">${c.position}</span></td>
      <td>${c.retailer||''}</td>
      <td>${c.department||''}</td>
      <td class="mono">${c.phone||''}</td>
      <td>${c.email||''}</td>
      <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="openEditContact(${c.id})">Edit</button></td>
    </tr>
  `).join('') || `<tr><td colspan="7"><div class="empty-state">No contacts match these filters.</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Contacts</h1><p>${state.contacts.length} contact${state.contacts.length===1?'':'s'}</p></div>
      <div class="row-actions">
        <button class="btn btn-primary" onclick="openNewContact()">+ New Contact</button>
      </div>
    </div>
    <div class="filters">
      <select onchange="setContactFilter('retailer', this.value)"><option value="">All retailers</option>${retailerOpts}</select>
      <select onchange="setContactFilter('department', this.value)"><option value="">All departments</option>${deptOpts}</select>
      <select onchange="setContactFilter('position', this.value)"><option value="">All positions</option>${posOpts}</select>
    </div>
    <div class="contacts-wrap">
      <table class="contacts-table">
        <thead>
          <tr><th>Name</th><th>Position</th><th>Retailer</th><th>Department</th><th>Contact number</th><th>Email</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderContactDrawerHost()}
  `;
}

function blankContactDraft(){
  return { id:null, first_name:'', last_name:'', position:'Buyer', phone:'', email:'', retailer:RETAILERS[0], department:DEPARTMENTS[0] };
}

function openNewContact(){
  state.contactDrawer = { contact: blankContactDraft(), isNew:true };
  render();
}
function openEditContact(id){
  const c = state.contacts.find(x=>x.id===id);
  if (!c) return;
  state.contactDrawer = { contact: {...c}, isNew:false };
  render();
}
function closeContactDrawer(){ state.contactDrawer = null; render(); }

function renderContactDrawerHost(){
  const d = state.contactDrawer;
  if (!d) return `<div class="overlay" onclick="closeContactDrawer()"></div><div class="drawer"></div>`;
  const c = d.contact;
  const posOpts = CONTACT_POSITIONS.map(p=>`<option value="${p}" ${c.position===p?'selected':''}>${p}</option>`).join('');
  const retailerOpts = RETAILERS.map(r=>`<option value="${r}" ${c.retailer===r?'selected':''}>${r}</option>`).join('');
  const deptOpts = DEPARTMENTS.map(dp=>`<option value="${dp}" ${c.department===dp?'selected':''}>${dp}</option>`).join('');
  return `
    <div class="overlay open" onclick="closeContactDrawer()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${d.isNew ? 'New Contact' : c.first_name+' '+c.last_name}</h2>
        <button class="drawer-close" onclick="closeContactDrawer()">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="row2">
          <div class="field"><label>First name</label><input id="cn-first_name" value="${c.first_name||''}"/></div>
          <div class="field"><label>Last name</label><input id="cn-last_name" value="${c.last_name||''}"/></div>
        </div>
        <div class="field"><label>Position</label><select id="cn-position">${posOpts}</select></div>
        <div class="row2">
          <div class="field"><label>Retailer</label><select id="cn-retailer">${retailerOpts}</select></div>
          <div class="field"><label>Department</label><select id="cn-department">${deptOpts}</select></div>
        </div>
        <div class="field"><label>Contact number</label><input id="cn-phone" value="${c.phone||''}" placeholder="082 555 1234"/></div>
        <div class="field"><label>Email</label><input id="cn-email" type="email" value="${c.email||''}" placeholder="name@retailer.co.za"/></div>
      </div>
      <footer class="drawer-actions">
        ${!d.isNew ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteContact(${c.id})">Delete</button>` : ''}
        <button class="btn btn-primary" onclick="saveContact()">${d.isNew ? 'Save contact' : 'Save changes'}</button>
      </footer>
    </div>`;
}

async function saveContact(){
  const first_name = document.getElementById('cn-first_name').value.trim();
  const last_name = document.getElementById('cn-last_name').value.trim();
  if (!first_name || !last_name) { toast('First and last name are required'); return; }
  const position = document.getElementById('cn-position').value;
  const body = {
    first_name, last_name, position,
    phone: document.getElementById('cn-phone').value.trim(),
    email: document.getElementById('cn-email').value.trim(),
    retailer: document.getElementById('cn-retailer').value,
    department: document.getElementById('cn-department').value,
  };
  try {
    const { isNew, contact } = state.contactDrawer;
    if (isNew) {
      await api('/api/contacts', { method:'POST', body: JSON.stringify(body) });
      toast('Contact added');
    } else {
      await api('/api/contacts/'+contact.id, { method:'PUT', body: JSON.stringify(body) });
      toast('Contact updated');
    }
    closeContactDrawer();
    await loadContacts();
  } catch(e) { toast(e.message); }
}

async function deleteContact(id){
  if (!confirm('Remove this contact?')) return;
  try {
    await api('/api/contacts/'+id, { method:'DELETE' });
    state.contacts = state.contacts.filter(c=>c.id!==id);
    closeContactDrawer();
    toast('Contact removed');
  } catch(e) { toast(e.message); }
}
