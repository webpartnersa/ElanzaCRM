const DEPARTMENTS = ['Ladies','Mens','Younger Boys','Older Boys','Younger Girls','Older Girls','Babywear'];

const state = {
  screen: 'loading', // loading | login | home | create | browse | detail | success
  user: null,
  loginBusy: false,
  loginError: '',

  // create form
  department: null,
  description: '',
  photos: [], // { file, previewUrl }
  submitting: false,
  submitError: '',
  validationHint: '',
  lastCreated: null, // { concept_no, department }

  // browse
  concepts: [],
  conceptsLoading: false,
  conceptsError: '',
  browseFilter: '',

  // detail
  conceptDetail: null, // { concept, photos, conversions }
  conceptDetailLoading: false,
  conceptDetailError: '',

  lightboxUrl: null,

  // install prompt
  installPromptEvent: null, // captured 'beforeinstallprompt' event, Android/Chrome only
  installBannerDismissed: false,
  isIOS: /iphone|ipad|ipod/.test(navigator.userAgent.toLowerCase()),
  isStandalone: window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
};

const ICONS = {
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  gallery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M20 15l-5-5-9 9"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  install: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0l-4-4m4 4l4-4"/><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>'
};

function esc(s){
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function hasConceptsPermission(){
  return (state.user.permissions || '').split(',').filter(Boolean).includes('concepts');
}

// ---- Screens ----

function renderLoading(){
  return `<div class="auth-screen"><div class="spinner"></div></div>`;
}

function renderLogin(){
  return `
  <div class="auth-screen">
    <div class="auth-card">
      <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
      <h1>Elanzas</h1>
      <p class="sub">Quick Concept Capture</p>
      ${state.loginError ? `<div class="error-msg">${esc(state.loginError)}</div>` : ''}
      <form id="loginForm">
        <div class="field">
          <label>Email</label>
          <input type="email" id="loginEmail" autocomplete="username" required/>
        </div>
        <div class="field">
          <label>Password</label>
          <input type="password" id="loginPassword" autocomplete="current-password" required/>
        </div>
        <button type="submit" class="btn-block primary" ${state.loginBusy ? 'disabled' : ''}>${state.loginBusy ? 'Signing in...' : 'Sign in'}</button>
      </form>
    </div>
  </div>`;
}

function renderHome(){
  if (!hasConceptsPermission()) {
    return `
    <div class="auth-screen">
      <div class="auth-card">
        <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
        <h1>Not available</h1>
        <p class="sub">Your account doesn't have access to Concepts. Signed in as ${esc(state.user.name)}.</p>
        <button class="btn-block ghost" onclick="logout()">Sign out</button>
      </div>
    </div>`;
  }
  const canCreate = state.user.role !== 'buyer';
  return `
  <div class="topbar">
    <div class="who">
      <div class="brand-mark"><img src="/mobile/icons/icon-192.png" alt=""/></div>
      <div>
        <h1>Elanzas</h1>
        <p class="user-name">${esc(state.user.name)}</p>
      </div>
    </div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>
  <div class="home-scroll">
    ${canCreate ? `
    <button class="dash-tile" onclick="goToCreate()">
      <div class="dash-icon">${ICONS.camera}</div>
      <div class="dash-text">
        <span class="dash-title">New Concept</span>
        <span class="dash-sub">Capture with photos</span>
      </div>
      <span class="dash-chevron">${ICONS.chevronRight}</span>
    </button>` : ''}
    <button class="dash-tile" onclick="goToBrowse()">
      <div class="dash-icon">${ICONS.grid}</div>
      <div class="dash-text">
        <span class="dash-title">Browse Concepts</span>
        <span class="dash-sub">View existing concepts</span>
      </div>
      <span class="dash-chevron">${ICONS.chevronRight}</span>
    </button>
  </div>`;
}

function renderCreate(){
  return `
  <div class="topbar">
    <button class="back-btn" onclick="goHome()">${ICONS.back}</button>
    <div class="topbar-title"><h1>New Concept</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>

  <div class="form-scroll">
    <div class="section">
      <div class="section-label">Department</div>
      <div class="chip-grid">
        ${DEPARTMENTS.map(d => `<button class="chip ${state.department===d?'selected':''}" onclick="selectDepartment('${d}')">${d}</button>`).join('')}
      </div>
    </div>

    <div class="section">
      <div class="section-label">Description <span style="font-weight:400;text-transform:none;">(optional)</span></div>
      <textarea class="desc-input" placeholder="e.g. Embroidered denim shorts" oninput="updateDescription(this.value)">${esc(state.description)}</textarea>
    </div>

    <div class="section">
      <div class="section-label">Photos ${state.photos.length ? `(${state.photos.length})` : ''}</div>
      <div class="photo-grid">
        ${state.photos.map((p,i) => `
          <div class="photo-tile">
            <img src="${p.previewUrl}" alt="" onclick="openLightbox('${p.previewUrl}')"/>
            <button class="photo-remove" onclick="removePhoto(${i})">&times;</button>
          </div>
        `).join('')}
      </div>
      ${state.photos.length === 0
        ? `<div class="add-photo-row">
            <button class="add-photo-tile big" onclick="openCamera()">${ICONS.camera}<span>Take Photo</span></button>
            <button class="add-photo-tile big" onclick="openGallery()">${ICONS.gallery}<span>Upload</span></button>
          </div>`
        : `<div class="add-photo-row compact">
            <button class="add-photo-tile" onclick="openCamera()">${ICONS.camera}<span>Camera</span></button>
            <button class="add-photo-tile" onclick="openGallery()">${ICONS.gallery}<span>Upload</span></button>
          </div>`
      }
      ${state.photos.length === 0 ? `<div class="section-hint">At least one photo is required.</div>` : ''}
      ${state.submitError ? `<div class="photo-warning">${esc(state.submitError)}</div>` : ''}
    </div>
  </div>

  <div class="bottom-bar">
    ${state.validationHint ? `<div class="validation-hint">${esc(state.validationHint)}</div>` : ''}
    <button class="btn-block primary" ${state.submitting ? 'disabled' : ''} onclick="submitConcept()">${state.submitting ? 'Creating...' : 'Create Concept'}</button>
  </div>`;
}

function renderBrowse(){
  const filtered = state.browseFilter ? state.concepts.filter(c => c.department === state.browseFilter) : state.concepts;
  return `
  <div class="topbar">
    <button class="back-btn" onclick="goHome()">${ICONS.back}</button>
    <div class="topbar-title"><h1>Browse Concepts</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>

  <div class="form-scroll">
    <div class="chip-grid">
      <button class="chip ${!state.browseFilter ? 'selected' : ''}" onclick="selectBrowseFilter('')">All</button>
      ${DEPARTMENTS.map(d => `<button class="chip ${state.browseFilter===d?'selected':''}" onclick="selectBrowseFilter('${d}')">${d}</button>`).join('')}
    </div>

    ${state.conceptsLoading ? `<div class="spinner" style="margin-top:40px;"></div>` : ''}
    ${state.conceptsError ? `<div class="error-msg" style="margin-top:16px;">${esc(state.conceptsError)}</div>` : ''}
    ${!state.conceptsLoading && !state.conceptsError && filtered.length === 0 ? `<div class="section-hint" style="margin-top:20px;">No concepts found.</div>` : ''}

    <div class="concept-list">
      ${filtered.map(c => `
        <button class="concept-card" onclick="openConceptDetail(${c.id})">
          <div class="concept-thumb">${c.cover_photo ? `<img src="${c.cover_photo}" alt=""/>` : `<div class="concept-thumb-empty">${ICONS.gallery}</div>`}</div>
          <div class="concept-info">
            <div class="concept-no-label">${esc(c.concept_no)}</div>
            <div class="concept-dept">${esc(c.department)}</div>
            ${c.description ? `<div class="concept-desc">${esc(c.description)}</div>` : ''}
          </div>
        </button>
      `).join('')}
    </div>
  </div>`;
}

function renderDetail(){
  const d = state.conceptDetail;
  return `
  <div class="topbar">
    <button class="back-btn" onclick="closeDetail()">${ICONS.back}</button>
    <div class="topbar-title"><h1>${d ? esc(d.concept.concept_no) : 'Concept'}</h1></div>
    <button class="signout" onclick="logout()">Sign out</button>
  </div>

  <div class="form-scroll">
    ${state.conceptDetailLoading ? `<div class="spinner" style="margin-top:40px;"></div>` : ''}
    ${state.conceptDetailError ? `<div class="error-msg" style="margin-top:16px;">${esc(state.conceptDetailError)}</div>` : ''}
    ${d ? `
      <div class="detail-header">
        <span class="chip selected" style="pointer-events:none;">${esc(d.concept.department)}</span>
      </div>
      ${d.concept.description ? `<p class="detail-desc">${esc(d.concept.description)}</p>` : ''}
      <div class="section-label" style="margin-top:22px;">Photos ${d.photos.length ? `(${d.photos.length})` : ''}</div>
      <div class="photo-grid">
        ${d.photos.map(p => `
          <button class="photo-tile view-only" onclick="openLightbox('${p.path}')">
            <img src="${p.thumb_path || p.path}" alt=""/>
          </button>
        `).join('')}
      </div>
      ${!d.photos.length ? `<div class="section-hint">No photos on this concept.</div>` : ''}
    ` : ''}
  </div>`;
}

function renderSuccess(){
  const c = state.lastCreated;
  return `
  <div class="success-screen">
    <div class="success-check">${ICONS.check}</div>
    <div class="label">Concept Created</div>
    <div class="concept-no">${esc(c.concept_no)}</div>
    <div class="dept">${esc(c.department)}</div>
    <div class="actions">
      <button class="btn-block primary" onclick="resetForm('create')">Add Another Concept</button>
      <button class="btn-block ghost" onclick="resetForm('home')">Back to Home</button>
    </div>
  </div>`;
}

function renderLightbox(){
  if (!state.lightboxUrl) return '';
  return `
  <div class="lightbox" onclick="closeLightbox()">
    <button class="lightbox-close" onclick="closeLightbox()">${ICONS.close}</button>
    <img src="${state.lightboxUrl}" onclick="event.stopPropagation()"/>
  </div>`;
}

// Shown above everything else so a merchandiser opening a shared link can
// add the app to their home screen immediately, without hunting through the
// browser menu. Android/Chrome gets a real one-tap install via the captured
// beforeinstallprompt event; iOS Safari has no programmatic install API, so
// it gets a "tap Share, then Add to Home Screen" instruction instead.
function renderInstallBanner(){
  if (state.isStandalone || state.installBannerDismissed || state.screen === 'loading') return '';
  if (state.installPromptEvent) {
    return `
    <div class="install-banner">
      <div class="install-banner-icon">${ICONS.install}</div>
      <div class="install-banner-text"><strong>Install Elanzas</strong><span>Add to your home screen for quick access</span></div>
      <button class="install-banner-btn" onclick="triggerInstall()">Install</button>
      <button class="install-banner-close" onclick="dismissInstallBanner()">${ICONS.close}</button>
    </div>`;
  }
  if (state.isIOS) {
    return `
    <div class="install-banner">
      <div class="install-banner-icon">${ICONS.install}</div>
      <div class="install-banner-text"><strong>Install Elanzas</strong><span>Tap the Share icon, then "Add to Home Screen"</span></div>
      <button class="install-banner-close" onclick="dismissInstallBanner()">${ICONS.close}</button>
    </div>`;
  }
  return '';
}

function render(){
  const app = document.getElementById('app');
  let html = '';
  if (state.screen === 'loading') html = renderLoading();
  else if (state.screen === 'login') html = renderLogin();
  else if (state.screen === 'home') html = renderHome();
  else if (state.screen === 'create') html = renderCreate();
  else if (state.screen === 'browse') html = renderBrowse();
  else if (state.screen === 'detail') html = renderDetail();
  else if (state.screen === 'success') html = renderSuccess();
  app.innerHTML = renderInstallBanner() + html + renderLightbox();

  const loginForm = document.getElementById('loginForm');
  if (loginForm) loginForm.addEventListener('submit', (e) => { e.preventDefault(); login(); });
}

// ---- Auth ----

async function checkSession(){
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { state.screen = 'login'; return render(); }
    const data = await res.json();
    state.user = data.user;
    state.screen = 'home';
  } catch (e) {
    state.screen = 'login';
  }
  render();
}

async function login(){
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  state.loginBusy = true;
  state.loginError = '';
  render();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) {
      state.loginError = data.error || 'Invalid email or password';
      state.loginBusy = false;
      return render();
    }
    state.user = data.user;
    state.loginBusy = false;
    state.screen = 'home';
    render();
  } catch (e) {
    state.loginError = 'Could not reach the server';
    state.loginBusy = false;
    render();
  }
}

async function logout(){
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
  state.photos.forEach(p => URL.revokeObjectURL(p.previewUrl));
  state.user = null;
  state.department = null;
  state.description = '';
  state.photos = [];
  state.submitError = '';
  state.validationHint = '';
  state.lastCreated = null;
  state.concepts = [];
  state.conceptsError = '';
  state.browseFilter = '';
  state.conceptDetail = null;
  state.conceptDetailError = '';
  state.lightboxUrl = null;
  state.screen = 'login';
  render();
}

// ---- Navigation ----

function goHome(){
  state.screen = 'home';
  render();
}

function goToCreate(){
  state.screen = 'create';
  render();
}

function goToBrowse(){
  state.screen = 'browse';
  render();
  if (!state.concepts.length) loadConcepts();
}

// ---- Browse ----

async function loadConcepts(){
  state.conceptsLoading = true;
  state.conceptsError = '';
  render();
  try {
    const res = await fetch('/api/concepts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load concepts');
    state.concepts = data.concepts;
  } catch (e) {
    state.conceptsError = e.message || 'Could not reach the server';
  }
  state.conceptsLoading = false;
  render();
}

function selectBrowseFilter(d){
  state.browseFilter = d;
  render();
}

async function openConceptDetail(id){
  state.screen = 'detail';
  state.conceptDetail = null;
  state.conceptDetailLoading = true;
  state.conceptDetailError = '';
  render();
  try {
    const res = await fetch('/api/concepts/' + id);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load this concept');
    state.conceptDetail = data;
  } catch (e) {
    state.conceptDetailError = e.message || 'Could not reach the server';
  }
  state.conceptDetailLoading = false;
  render();
}

function closeDetail(){
  state.screen = 'browse';
  state.conceptDetail = null;
  render();
}

function openLightbox(url){
  state.lightboxUrl = url;
  render();
}

function closeLightbox(){
  state.lightboxUrl = null;
  render();
}

// ---- Create form actions ----

function selectDepartment(d){
  state.department = d;
  state.validationHint = '';
  render();
}

function updateDescription(v){
  state.description = v; // no re-render needed, textarea already reflects the keystroke
}

function openCamera(){
  const input = document.getElementById('cameraInput');
  input.value = '';
  input.click();
}

function openGallery(){
  const input = document.getElementById('galleryInput');
  input.value = '';
  input.click();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('cameraInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    state.photos.push({ file, previewUrl: URL.createObjectURL(file) });
    state.validationHint = '';
    render();
  });

  document.getElementById('galleryInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    files.forEach(file => state.photos.push({ file, previewUrl: URL.createObjectURL(file) }));
    state.validationHint = '';
    render();
  });
});

function removePhoto(i){
  const p = state.photos[i];
  if (p) URL.revokeObjectURL(p.previewUrl);
  state.photos.splice(i, 1);
  render();
}

async function submitConcept(){
  if (state.submitting) return;
  if (!state.department) { state.validationHint = 'Please select a department'; return render(); }
  if (!state.photos.length) { state.validationHint = 'Please take at least one photo'; return render(); }

  state.submitting = true;
  state.validationHint = '';
  state.submitError = '';
  render();

  try {
    const form = new FormData();
    form.append('department', state.department);
    form.append('description', state.description || '');
    state.photos.forEach(p => form.append('photos', p.file, p.file.name || 'photo.jpg'));

    const res = await fetch('/api/concepts', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      state.submitting = false;
      state.submitError = data.error || 'Could not create the concept';
      return render();
    }
    state.submitting = false;
    state.lastCreated = { concept_no: data.concept.concept_no, department: data.concept.department };
    // A newly created concept invalidates the cached browse list - refetch next visit.
    state.concepts = [];
    state.screen = 'success';
    render();
  } catch (e) {
    state.submitting = false;
    state.submitError = 'Could not reach the server - check your connection and try again';
    render();
  }
}

function resetForm(targetScreen){
  state.photos.forEach(p => URL.revokeObjectURL(p.previewUrl));
  state.department = null;
  state.description = '';
  state.photos = [];
  state.submitError = '';
  state.validationHint = '';
  state.lastCreated = null;
  state.screen = targetScreen || 'create';
  render();
}

// ---- Install prompt ----

async function triggerInstall(){
  if (!state.installPromptEvent) return;
  state.installPromptEvent.prompt();
  const choice = await state.installPromptEvent.userChoice;
  // A captured prompt event can only be used once, win or lose.
  state.installPromptEvent = null;
  if (choice.outcome === 'accepted') state.installBannerDismissed = true;
  render();
}

function dismissInstallBanner(){
  state.installBannerDismissed = true;
  render();
}

// Chrome/Android fires this once the page meets PWA install criteria
// (manifest + service worker + icons, all already in place). Calling
// preventDefault() suppresses the browser's own mini-infobar so the
// install-banner button can trigger the same native prompt on tap instead.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPromptEvent = e;
  render();
});

window.addEventListener('appinstalled', () => {
  state.installPromptEvent = null;
  state.installBannerDismissed = true;
  render();
});

// ---- Boot ----
render();
checkSession();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/mobile/sw.js').catch(() => {});
  });
}
