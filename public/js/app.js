// ---- Top-level router + boot. Loads last, after every section is defined. ----
function goto(view){
  state.view = view; state.modal = null;
  if (view==='concepts') loadConcepts();
  else if (view==='shipping') loadShipping();
  else if (view==='contacts') loadContacts();
  else if (view==='factories') loadFactories();
  else if (view==='requests') loadRequests();
  else if (view==='fabrics') loadFabrics();
  else if (view==='finance') { if (state.user.role==='admin') loadFinance(); else render(); }
  else if (view==='settings') { if (state.user.role==='admin') loadUsers(); else render(); }
  else if (view==='notifications') { if (hasPerm(state.user,'shipping') && !state.shipping) loadShipping(); else render(); }
  else if (view==='inbox') loadInboxEmails();
  else render();
}

function render(){
  const el = document.getElementById('app');
  if (state.view==='login') { el.innerHTML = renderLogin(); return; }
  el.innerHTML = renderShell();
}

// First section this user actually has access to, in priority order -
// Shipping first per the "open straight into Shipping" default, falling
// back down the list, and finally to Settings (Password is always
// reachable) if somehow nothing else is permitted.
function defaultView(user){
  if (hasPerm(user,'shipping')) return 'shipping';
  if (hasPerm(user,'styles')) return 'dashboard';
  if (hasPerm(user,'concepts')) return 'concepts';
  if (hasPerm(user,'contacts')) return 'contacts';
  return 'settings';
}

// Everything that needs to happen once a user object is in hand, whether
// that came from an existing session (init(), on page load) or a fresh
// login just now (doLogin(), in login.js) - both call this so the two
// paths can never drift apart (they used to: doLogin() skipped every one
// of these preloads, leaving things like the order drawer's fabric-code
// autofill and this Style drawer's Measurements tab quietly empty until
// the user happened to visit that section directly).
async function bootstrapApp(user){
  state.user = user;
  state.view = defaultView(user);
  // Buyer autofill on the New Style drawer (drawer.js) needs contacts
  // loaded up front, not just when the Contacts nav tab is visited.
  if (hasPerm(user,'contacts')) { initContactsState(); loadContacts(); }
  // Same story for the order drawer's fabric-code autofill (shipping.js).
  if (hasPerm(user,'fabrics')) { initFabricsState(); loadFabrics(); loadFabricReportFlags(); loadAllFabricReports(); }
  // Same story again for the Style drawer's Measurements tab (drawer.js) -
  // loadConcepts() also loads this, but only once the Concepts view is
  // actually visited, which a 'styles' user landing on their default view
  // (Shipping, Styles...) may never do this session even if they also
  // hold 'concepts' permission - so this can't be skipped just because
  // they have that permission, only reasoned about by what actually ran.
  // Same for the Style drawer's Details tab Sizes dropdown (size_range_id).
  if (hasPerm(user,'styles')) { loadSpecCategories(); loadSizeRanges(); }
  // Read/unread state feeds the sidebar's Notifications badge, which
  // renders on every screen - needs to be loaded up front too, not just
  // once the Notifications tab is visited.
  if (hasPerm(user,'shipping') || hasPerm(user,'fabrics')) { initNotificationsState(); loadNotificationReads(); }
  if (hasPerm(user,'shipping')) { initShippingState(); loadOrderDocFlags(); }

  if (state.view === 'shipping') await loadShipping();
  else if (state.view === 'concepts') await loadConcepts();
  else if (state.view === 'settings') { if (user.role==='admin') loadUsers(); else render(); }
  else if (state.view === 'dashboard') await loadStyles();
  else render(); // contacts landing (already loading above) or no permitted section at all

  // Background-preload Styles for a snappy tab switch later, unless it's
  // already the landing view (loaded, and rendered, above).
  if (state.view !== 'dashboard' && hasPerm(user,'styles')) loadStyles();
}

async function init(){
  try {
    const { user } = await api('/api/me');
    await bootstrapApp(user);
  }
  catch(e) { state.view='login'; render(); }
}

init();
