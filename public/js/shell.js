// ---- Sidebar / layout shared by every logged-in screen ----
async function doLogout(){
  await api('/api/logout', {method:'POST'});
  state = {user:null, styles:[], users:[], view:'login', current:null, modal:null};
  render();
}

function renderShell(){
  const u = state.user;
  const scopeLine = u.role==='buyer' ? `${u.retailer} · ${u.department}` : (u.role==='admin' ? 'Admin' : 'All retailers');
  const alertCount = collectUnreadNotificationCount();
  return `
    <aside class="sidebar">
      <div class="sidelogo"><img src="/img/E-Logo-concept.PNG"></div>
      <nav class="nav">
        ${hasPerm(u,'shipping') ? `<a class="${state.view==='shipping'?'active':''}" onclick="goto('shipping')"><span class="nav-dot"></span>Orders</a>` : ''}
        ${hasPerm(u,'shipping') ? `<a class="${state.view==='tasksDemo'?'active':''}" onclick="goto('tasksDemo')"><span class="nav-dot"></span>Tasks (Demo)</a>` : ''}
        ${(hasPerm(u,'shipping')||hasPerm(u,'fabrics')) ? `<a class="${state.view==='notifications'?'active':''}" onclick="goto('notifications')"><span class="nav-dot" style="${alertCount?'background:var(--stitch-red);':''}"></span>Notifications${alertCount?` (${alertCount})`:''}</a>` : ''}
        ${hasPerm(u,'styles') ? `<a class="${state.view==='dashboard'?'active':''}" onclick="goto('dashboard')"><span class="nav-dot"></span>Styles</a>` : ''}
        ${hasPerm(u,'concepts') ? `<a class="${state.view==='concepts'?'active':''}" onclick="goto('concepts')"><span class="nav-dot"></span>Concepts</a>` : ''}
        ${hasPerm(u,'concepts') && u.role!=='buyer' ? `<a class="${state.view==='requests'?'active':''}" onclick="goto('requests')"><span class="nav-dot"></span>Requests</a>` : ''}
        ${hasPerm(u,'contacts') ? `<a class="${state.view==='contacts'?'active':''}" onclick="goto('contacts')"><span class="nav-dot"></span>Contacts</a>` : ''}
        ${hasPerm(u,'factories') ? `<a class="${state.view==='factories'?'active':''}" onclick="goto('factories')"><span class="nav-dot"></span>Factories</a>` : ''}
        ${hasPerm(u,'fabrics') ? `<a class="${state.view==='fabrics'?'active':''}" onclick="gotoFabrics()"><span class="nav-dot"></span>Fabrics</a>` : ''}
        ${u.role==='admin' ? `<a class="${state.view==='finance'?'active':''}" onclick="goto('finance')"><span class="nav-dot"></span>Finance</a>` : ''}
        <a class="${state.view==='settings'?'active':''}" onclick="goto('settings')"><span class="nav-dot" style="background:transparent;border:1px solid #7E8FA0;"></span>Settings</a>
        <a onclick="doLogout()"><span class="nav-dot" style="background:transparent;border:1px solid #7E8FA0;"></span>Sign out</a>
      </nav>
      <div class="sidebar-foot mono">Signed in as ${u.name}</div>
    </aside>
    <main class="main">
      ${state.view==='dashboard' ? renderDashboard() : ''}
      ${state.view==='concepts' ? renderConceptsView() : ''}
      ${state.view==='shipping' ? renderShippingView() : ''}
      ${state.view==='tasksDemo' ? renderTasksDemoView() : ''}
      ${state.view==='notifications' ? renderNotificationsView() : ''}
      ${state.view==='contacts' ? renderContactsView() : ''}
      ${state.view==='factories' ? renderFactoriesView() : ''}
      ${state.view==='requests' ? renderRequestsView() : ''}
      ${state.view==='fabrics' ? renderFabricsView() : ''}
      ${state.view==='finance' ? renderFinanceView() : ''}
      ${state.view==='settings' ? renderSettingsView() : ''}
    </main>
    ${state.modal ? renderModal() : ''}
    ${renderDrawerHost()}
    ${hasPerm(u,'fabrics') ? renderTestReportUploadHost() : ''}
    ${(hasPerm(u,'concepts')||hasPerm(u,'styles')) ? renderSpecManagerHost() : ''}
    ${hasPerm(u,'styles') ? renderManualFitEntryHost() + renderFitSheetUploadHost() : ''}
  `;
}
