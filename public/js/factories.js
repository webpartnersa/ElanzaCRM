// ---- Factories: the real factory entities (internal reference name +
// registered legal name + address + certifications), each with its own
// Factory-position Contacts underneath it (see db.js's comment on the
// factories table, and routes/factories.js for the nested contacts API).
// Concept/Style Factory dropdowns read factory names from a separate
// lightweight endpoint (see loadConcepts()'s /factory-names call), not from
// this state - this page is purely for managing the entities themselves.

function initFactoriesState(){
  if (!state.factories) state.factories = [];
  if (state.factoryDrawer === undefined) state.factoryDrawer = null;
  if (state.factoryContactForm === undefined) state.factoryContactForm = null;
}

async function loadFactories(){
  initFactoriesState();
  const { factories } = await api('/api/factories');
  state.factories = factories;
  render();
}

function renderFactoriesView(){
  initFactoriesState();
  const canEdit = state.user.role !== 'buyer';
  const rows = state.factories.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(f => `
    <tr>
      <td class="name-cell">${f.name}</td>
      <td>${f.registered_name||''}</td>
      <td>${f.address||''}</td>
      <td>${f.contact_count||0}</td>
      <td style="text-align:right;"><button class="btn btn-ghost btn-sm" onclick="openEditFactory(${f.id})">Edit</button></td>
    </tr>`
  ).join('') || `<tr><td colspan="5"><div class="empty-state">No factories added yet.</div></td></tr>`;

  return `
    <div class="topbar">
      <div><h1 class="display">Factories</h1><p>${state.factories.length} factor${state.factories.length===1?'y':'ies'}</p></div>
      <div class="row-actions">
        ${canEdit ? `<button class="btn btn-primary" onclick="openNewFactory()">+ New Factory</button>` : ''}
      </div>
    </div>
    <div class="hint" style="margin-top:8px;">Manage factory contacts, certifications and addresses here - anything to do with a factory lives in this section, including its people (see Contacts below, once a factory is open).</div>
    <div class="contacts-wrap" style="margin-top:14px;">
      <table class="contacts-table">
        <thead>
          <tr><th>Factory name</th><th>Registered name</th><th>Address</th><th>Contacts</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderFactoryDrawerHost()}
  `;
}

function blankFactoryDraft(){
  return { id:null, name:'', registered_name:'', address:'', certifications:'', country:'', importer_vendor_code:'' };
}

function openNewFactory(){
  state.factoryDrawer = { factory: blankFactoryDraft(), isNew:true, contacts: [] };
  state.factoryContactForm = null;
  render();
}

async function openEditFactory(id){
  try {
    const { factory, contacts } = await api('/api/factories/'+id);
    state.factoryDrawer = { factory, isNew:false, contacts };
    state.factoryContactForm = null;
    render();
  } catch(e) { toast(e.message); }
}

function closeFactoryDrawer(){
  state.factoryDrawer = null;
  state.factoryContactForm = null;
  render();
}

function renderFactoryDrawerHost(){
  const d = state.factoryDrawer;
  if (!d) return `<div class="overlay" onclick="closeFactoryDrawer()"></div><div class="drawer"></div>`;
  const f = d.factory;
  const canEdit = state.user.role !== 'buyer';
  return `
    <div class="overlay open" onclick="closeFactoryDrawer()"></div>
    <div class="drawer open">
      <div class="drawer-head">
        <h2>${d.isNew ? 'New Factory' : f.name}</h2>
        <button class="drawer-close" onclick="closeFactoryDrawer()">&times;</button>
      </div>
      <div class="drawer-body">
        <div class="field"><label>Factory name (for our reference)</label><input id="fc-name" value="${(f.name||'').replace(/"/g,'&quot;')}" placeholder="e.g. CK Factory"/></div>
        <div class="field"><label>Garment Factory (real registered name)</label><input id="fc-registered_name" value="${(f.registered_name||'').replace(/"/g,'&quot;')}" placeholder="e.g. CK Benke Clothing (Pty) Ltd"/></div>
        <div class="field"><label>Address</label><textarea id="fc-address">${f.address||''}</textarea></div>
        <div class="field"><label>Country</label><input id="fc-country" value="${(f.country||'').replace(/"/g,'&quot;')}" placeholder="e.g. China"/></div>
        <div class="field"><label>Importer/Vendor code</label><input id="fc-importer_vendor_code" value="${(f.importer_vendor_code||'').replace(/"/g,'&quot;')}" placeholder="e.g. CU25179051"/></div>
        <div class="field"><label>Certifications</label><textarea id="fc-certifications" placeholder="e.g. BSCI, WRAP, SEDEX">${f.certifications||''}</textarea></div>
      </div>
      <footer class="drawer-actions">
        ${!d.isNew && canEdit ? `<button class="btn btn-danger" style="margin-right:auto;" onclick="deleteFactory(${f.id})">Delete</button>` : ''}
        ${canEdit ? `<button class="btn btn-primary" onclick="saveFactory()">${d.isNew ? 'Save factory' : 'Save changes'}</button>` : ''}
      </footer>
      ${!d.isNew ? renderFactoryContactsSection(d, canEdit) : ''}
    </div>`;
}

function renderFactoryContactsSection(d, canEdit){
  const rows = d.contacts.map(c => `
    <tr>
      <td class="name-cell">${c.first_name} ${c.last_name}</td>
      <td>${c.job_title||''}</td>
      <td class="mono">${c.phone||''}</td>
      <td>${c.email||''}</td>
      <td style="text-align:right;">${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openEditFactoryContact(${c.id})">Edit</button>` : ''}</td>
    </tr>`
  ).join('') || `<tr><td colspan="5"><div class="empty-state">No contacts at this factory yet.</div></td></tr>`;

  return `
    <div class="drawer-body" style="border-top:1px solid var(--stitch-border,#e5e5e5);">
      <div class="topbar" style="margin-top:0;">
        <div><h2 style="margin:0;">Contacts</h2></div>
        <div class="row-actions">${canEdit ? `<button class="btn btn-ghost btn-sm" onclick="openNewFactoryContact()">+ Add contact</button>` : ''}</div>
      </div>
      <div class="contacts-wrap" style="margin-top:10px;">
        <table class="contacts-table">
          <thead><tr><th>Name</th><th>Position</th><th>Contact number</th><th>Email</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${state.factoryContactForm ? renderFactoryContactForm() : ''}
    </div>`;
}

function renderFactoryContactForm(){
  const c = state.factoryContactForm;
  return `
    <div class="field" style="margin-top:14px;"><label>First name</label><input id="fcn-first_name" value="${(c.first_name||'').replace(/"/g,'&quot;')}"/></div>
    <div class="field"><label>Last name</label><input id="fcn-last_name" value="${(c.last_name||'').replace(/"/g,'&quot;')}"/></div>
    <div class="field"><label>Position</label><input id="fcn-job_title" value="${(c.job_title||'').replace(/"/g,'&quot;')}" placeholder="e.g. Merchandiser, QC Manager, Owner"/></div>
    <div class="field"><label>Contact number</label><input id="fcn-phone" value="${c.phone||''}" placeholder="082 555 1234"/></div>
    <div class="field"><label>Email</label><input id="fcn-email" type="email" value="${c.email||''}"/></div>
    <div class="row-actions" style="margin-top:10px;">
      ${c.id ? `<button class="btn btn-danger btn-sm" onclick="deleteFactoryContact(${c.id})">Delete</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="closeFactoryContactForm()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="saveFactoryContact()">${c.id ? 'Save changes' : 'Save contact'}</button>
    </div>`;
}

function openNewFactoryContact(){
  state.factoryContactForm = { id:null, first_name:'', last_name:'', job_title:'', phone:'', email:'' };
  render();
}
function openEditFactoryContact(id){
  const c = state.factoryDrawer.contacts.find(x=>x.id===id);
  if (!c) return;
  state.factoryContactForm = {...c};
  render();
}
function closeFactoryContactForm(){
  state.factoryContactForm = null;
  render();
}

async function saveFactory(){
  const name = document.getElementById('fc-name').value.trim();
  if (!name) { toast('Factory name is required'); return; }
  const body = {
    name,
    registered_name: document.getElementById('fc-registered_name').value.trim(),
    address: document.getElementById('fc-address').value.trim(),
    country: document.getElementById('fc-country').value.trim(),
    importer_vendor_code: document.getElementById('fc-importer_vendor_code').value.trim(),
    certifications: document.getElementById('fc-certifications').value.trim(),
  };
  try {
    const { isNew, factory } = state.factoryDrawer;
    if (isNew) {
      await api('/api/factories', { method:'POST', body: JSON.stringify(body) });
      toast('Factory added');
    } else {
      await api('/api/factories/'+factory.id, { method:'PUT', body: JSON.stringify(body) });
      toast('Factory updated');
    }
    closeFactoryDrawer();
    await loadFactories();
  } catch(e) { toast(e.message); }
}

async function deleteFactory(id){
  if (!confirm('Remove this factory? Its contacts are kept but unlinked from it.')) return;
  try {
    await api('/api/factories/'+id, { method:'DELETE' });
    state.factories = state.factories.filter(f=>f.id!==id);
    closeFactoryDrawer();
    toast('Factory removed');
  } catch(e) { toast(e.message); }
}

async function saveFactoryContact(){
  const first_name = document.getElementById('fcn-first_name').value.trim();
  const last_name = document.getElementById('fcn-last_name').value.trim();
  if (!first_name || !last_name) { toast('First and last name are required'); return; }
  const body = {
    first_name, last_name,
    job_title: document.getElementById('fcn-job_title').value.trim(),
    phone: document.getElementById('fcn-phone').value.trim(),
    email: document.getElementById('fcn-email').value.trim(),
  };
  const factoryId = state.factoryDrawer.factory.id;
  try {
    if (state.factoryContactForm.id) {
      const { contact } = await api(`/api/factories/${factoryId}/contacts/${state.factoryContactForm.id}`, { method:'PUT', body: JSON.stringify(body) });
      state.factoryDrawer.contacts = state.factoryDrawer.contacts.map(c => c.id===contact.id ? contact : c);
      toast('Contact updated');
    } else {
      const { contact } = await api(`/api/factories/${factoryId}/contacts`, { method:'POST', body: JSON.stringify(body) });
      state.factoryDrawer.contacts.push(contact);
      toast('Contact added');
    }
    closeFactoryContactForm();
    loadFactories();
  } catch(e) { toast(e.message); }
}

async function deleteFactoryContact(id){
  if (!confirm('Remove this contact?')) return;
  const factoryId = state.factoryDrawer.factory.id;
  try {
    await api(`/api/factories/${factoryId}/contacts/${id}`, { method:'DELETE' });
    state.factoryDrawer.contacts = state.factoryDrawer.contacts.filter(c=>c.id!==id);
    closeFactoryContactForm();
    toast('Contact removed');
    loadFactories();
  } catch(e) { toast(e.message); }
}
