// Shared app state and the one function everything else uses to talk to the backend.
let state = { user:null, styles:[], users:[], view:'login', drawer:null, modal:null };

async function api(path, opts={}) {
  const res = await fetch(path, { headers:{'Content-Type':'application/json'}, ...opts });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// Section access is per-user (Settings > Users & Permissions), independent
// of role - role still governs field-level scoping and edit rights.
function hasPerm(user, section){
  return (user.permissions || '').split(',').filter(Boolean).includes(section);
}
