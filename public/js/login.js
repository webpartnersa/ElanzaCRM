// ---- Login screen ----
function renderLogin(){
  return `
    <div class="login-screen">
      <div class="login-box">
        <div class="wordmark"><img src="/img/main-LOGO-250px.PNG"></div>
        <p class="sub">Sign in to view your styles</p>
        <div id="login-err" class="err hidden"></div>
        <div class="field">
          <label>Email</label>
          <input id="li-email" type="email" autocomplete="username"/>
        </div>
        <div class="field">
          <label>Password</label>
          <input id="li-pass" type="password" autocomplete="current-password"/>
        </div>
        <button class="btn btn-primary loginb" style="width:100%;justify-content:center;" onclick="doLogin()">Sign in</button>
      </div>
    </div>`;
}

async function doLogin(){
  const email = document.getElementById('li-email').value;
  const password = document.getElementById('li-pass').value;
  try {
    const { user } = await api('/api/login', { method:'POST', body: JSON.stringify({email,password}) });
    state.user = user; state.view='dashboard'; await loadStyles();
  } catch(e) {
    const err = document.getElementById('login-err'); err.textContent = e.message; err.classList.remove('hidden');
  }
}
