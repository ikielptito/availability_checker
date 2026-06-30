/* Shared Samba account nav — app-style tab bar (bottom on mobile, top on
 * desktop), agent/owner mode toggle, sign-in popup, and an account sheet with
 * profile editing + photo upload. Self-mounts into <div id="samba-nav"> and a
 * body-appended bottom bar. One Google login works across the agent and owner
 * sides (see api/portal.js).
 *
 * window.SambaNav:
 *   .account / .isSignedIn() / .openSignIn() / .requireSignIn(fn)
 *   .openAccount() / .onChange(fn) / .updateFavorites(a) / .refresh()
 *   .getMode() / .setMode(m)
 */
(function () {
  if (window.SambaNav) return;
  var API = '/api/portal';
  var isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  var account = null, listeners = [], pendingAfterSignIn = null, cfgPromise = null;
  var pendingPhoto = null; // data URL staged in the account sheet before save

  // ── Styles ──
  var css = `
  #samba-nav{display:inline-flex}
  .snav-top{display:inline-flex;align-items:center;gap:4px}
  .snav-tab{display:inline-flex;align-items:center;gap:7px;background:none;border:none;font-family:'Sora',-apple-system,sans-serif;font-size:.82rem;font-weight:500;color:#6b6557;text-decoration:none;padding:8px 13px;border-radius:9px;cursor:pointer;transition:background .15s,color .15s}
  .snav-top .snav-tab:hover{background:#f3efe6;color:#1a1814}
  .snav-tab.on{color:#c26a4a}
  .snav-tab svg{width:18px;height:18px;flex-shrink:0}
  .snav-av{width:26px;height:26px;border-radius:50%;background:#c26a4a;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:.72rem;font-weight:600}
  .snav-av img{width:100%;height:100%;object-fit:cover}
  .snav-av svg{width:16px;height:16px}
  /* Bottom bar (mobile) */
  #snav-tabs{position:fixed;left:0;right:0;bottom:0;z-index:900;display:none;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border-top:1px solid #e8e2d8;padding:6px 6px calc(6px + env(safe-area-inset-bottom));justify-content:space-around}
  #snav-tabs .snav-tab{flex-direction:column;gap:3px;font-size:.62rem;font-weight:500;padding:5px 8px;flex:1;border-radius:11px;color:#8a8478}
  #snav-tabs .snav-tab.on{color:#c26a4a}
  #snav-tabs .snav-tab svg{width:22px;height:22px}
  #snav-tabs .snav-av{width:23px;height:23px}
  @media(max-width:760px){ #snav-tabs{display:flex} #samba-nav{display:none} body{padding-bottom:62px} }
  /* Overlays (sign-in + account sheet) */
  .snav-ov{position:fixed;inset:0;background:rgba(26,24,20,.5);z-index:1100;display:none;align-items:flex-start;justify-content:center;padding:7vh 16px;overflow-y:auto}
  .snav-ov.open{display:flex}
  .snav-box{background:#fff;border:1px solid #e8e2d8;border-radius:16px;max-width:420px;width:100%;box-shadow:0 12px 40px rgba(60,45,20,.2)}
  .snav-box-head{padding:16px 20px;border-bottom:1px solid #eee6da;display:flex;align-items:center;justify-content:space-between}
  .snav-box-title{font-family:'Playfair Display',Georgia,serif;font-size:1.2rem;color:#1a1814}
  .snav-x{background:none;border:none;font-size:1.5rem;line-height:1;color:#8a8478;cursor:pointer;padding:0 4px}
  .snav-box-body{padding:18px 20px;display:flex;flex-direction:column;gap:13px}
  .snav-lede{color:#8a8478;font-size:.88rem;line-height:1.5;text-align:center}
  .snav-gbtn{display:flex;justify-content:center;min-height:44px}
  .snav-guest{display:block;width:100%;text-align:center;background:none;border:none;color:#8a8478;font-family:inherit;font-size:.82rem;cursor:pointer;padding:4px;text-decoration:underline}
  .snav-acct-top{display:flex;align-items:center;gap:13px}
  .snav-acct-av{width:58px;height:58px;border-radius:50%;background:#c26a4a;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:'Playfair Display',serif;font-size:1.4rem;flex-shrink:0;position:relative}
  .snav-acct-av img{width:100%;height:100%;object-fit:cover}
  .snav-cam{position:absolute;right:-2px;bottom:-2px;width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid #e2dccf;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#3d3a32}
  .snav-cam svg{width:13px;height:13px}
  .snav-acct-id{min-width:0}
  .snav-acct-name{font-family:'Playfair Display',serif;font-size:1.15rem;color:#1a1814}
  .snav-acct-email{font-size:.74rem;color:#8a8478;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .snav-fg label{display:block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478;margin-bottom:6px}
  .snav-req{color:#c26a4a}
  .snav-fg input{width:100%;background:#f3efe6;border:1px solid #e8e2d8;border-radius:9px;padding:11px 13px;font-family:inherit;font-size:.85rem;color:#1a1814;outline:none;box-sizing:border-box}
  .snav-fg input:focus{border-color:#c26a4a}
  .snav-row{display:flex;align-items:center;gap:9px;font-size:.85rem;color:#3d3a32}
  .snav-row input{width:auto}
  .snav-link-box{background:#f3efe6;border:1px solid #e8e2d8;border-radius:9px;padding:9px 12px;font-size:.76rem;color:#3d3a32;word-break:break-all}
  .snav-banner{background:#f9ede7;border:1px solid #e8c9b9;color:#a55638;border-radius:10px;padding:10px 12px;font-size:.8rem;line-height:1.45}
  .snav-btn{background:#c26a4a;color:#fff;border:none;border-radius:9px;padding:11px 16px;font-family:inherit;font-size:.85rem;font-weight:500;cursor:pointer}
  .snav-btn:hover{background:#a55638}
  .snav-btn.ghost{background:#f3efe6;color:#1a1814}
  .snav-btn.block{width:100%}
  .snav-btn svg{width:15px;height:15px;vertical-align:-2px}
  .snav-mode .snav-btn{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;flex-shrink:0}
  .snav-div{height:1px;background:#eee6da;margin:4px 0}
  .snav-mode{display:flex;align-items:center;gap:10px;background:#f3efe6;border:1px solid #e8e2d8;border-radius:11px;padding:12px 14px}
  .snav-mode-txt{flex:1;min-width:0}
  .snav-mode-txt b{font-size:.9rem;color:#1a1814}
  .snav-mode-txt span{display:block;font-size:.72rem;color:#8a8478}
  .snav-list-link{display:flex;align-items:center;gap:10px;padding:11px 6px;font-size:.88rem;color:#1a1814;text-decoration:none;background:none;border:none;font-family:inherit;cursor:pointer;width:100%;text-align:left}
  .snav-list-link:hover{color:#c26a4a}
  .snav-list-link svg{width:17px;height:17px;color:#8a8478}
  .snav-err{color:#a8331f;font-size:.78rem;min-height:1em;text-align:center}
  `;
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // ── Icons ──
  var I = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/></svg>',
    browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>',
    saved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 6v1h18v-1c0-3.5-4-6-9-6Z"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function initials(n) { return (n || 'A').trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }

  // ── Mode ──
  function getMode() {
    var m = localStorage.getItem('samba_mode');
    if (m === 'agent' || m === 'owner') return m;
    return (account && account.hasListings) ? 'owner' : 'agent';
  }
  function setMode(m) {
    localStorage.setItem('samba_mode', m);
    renderTabs();
    location.href = m === 'owner' ? '/portal' : '/';
  }

  // ── Tabs ──
  function curKey() {
    var p = location.pathname, v = new URLSearchParams(location.search).get('view');
    if (p === '/home' || p === '/home.html') return 'home';
    if (p === '/portal' || p === '/portal.html') return 'dashboard';
    if (p === '/' || p === '/index.html') return v === 'saved' ? 'saved' : 'browse';
    return '';
  }
  function tabsForMode() {
    var mode = getMode();
    var owner = mode === 'owner';
    return [
      { key: 'home', label: 'Home', href: '/home', icon: I.home },
      { key: 'browse', label: 'Browse', href: '/', icon: I.browse },
      owner ? { key: 'dashboard', label: 'Dashboard', href: '/portal', icon: I.dashboard }
            : { key: 'saved', label: 'Saved', href: '/?view=saved', icon: I.saved },
      { key: 'profile', label: 'Profile', action: 'account', icon: avatarIcon() },
    ];
  }
  function avatarIcon() {
    if (account) {
      var ph = (account.profile && account.profile.photo) || account.picture;
      return '<span class="snav-av">' + (ph ? '<img src="' + esc(ph) + '" alt="">' : esc(initials((account.profile && account.profile.displayName) || account.name))) + '</span>';
    }
    return I.user;
  }
  function tabHtml(t, active) {
    var inner = t.icon + '<span>' + esc(t.label) + '</span>';
    if (t.action) return '<button class="snav-tab' + (active ? ' on' : '') + '" data-act="' + t.action + '">' + inner + '</button>';
    return '<a class="snav-tab' + (active ? ' on' : '') + '" href="' + t.href + '">' + inner + '</a>';
  }
  function renderTabs() {
    var tabs = tabsForMode(), key = curKey();
    var html = tabs.map(function (t) { return tabHtml(t, t.key === key); }).join('');
    var top = document.getElementById('samba-nav');
    if (top) { top.innerHTML = '<div class="snav-top">' + html + '</div>'; wire(top); }
    var bottom = document.getElementById('snav-tabs');
    if (!bottom) { bottom = document.createElement('div'); bottom.id = 'snav-tabs'; document.body.appendChild(bottom); }
    bottom.innerHTML = html; wire(bottom);
  }
  function wire(root) {
    root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function () { if (el.getAttribute('data-act') === 'account') openAccount(); });
    });
  }

  // ── Auth ──
  function api(path, opts) {
    return fetch(API + path, Object.assign({ credentials: 'include' }, opts || {}))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: r.ok, status: r.status, body: null }; }); });
  }
  function loadConfig() { if (!cfgPromise) cfgPromise = api('?action=config').then(function (r) { return r.body || {}; }); return cfgPromise; }
  function setAccount(a) { account = a; renderTabs(); listeners.forEach(function (fn) { try { fn(account); } catch (e) {} }); }
  function loadMe() { return api('?action=auth/me').then(function (r) { setAccount(r.ok && r.body && r.body.owner ? r.body.owner : null); return account; }); }

  function loadGsi(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    var s = document.getElementById('snav-gsi');
    if (!s) { s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.id = 'snav-gsi'; document.head.appendChild(s); }
    var t = setInterval(function () { if (window.google && google.accounts && google.accounts.id) { clearInterval(t); cb(); } }, 100);
  }
  function ensureSignIn() {
    var ov = document.getElementById('snav-signin'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-signin';
    ov.innerHTML = '<div class="snav-box"><div class="snav-box-head"><div class="snav-box-title">Welcome to Samba</div><button class="snav-x" data-close>&times;</button></div><div class="snav-box-body"><p class="snav-lede">Sign in to save villas, build client shortlists, and share them.</p><div class="snav-gbtn" id="snav-gbtn"></div><div class="snav-err" id="snav-signin-err"></div><button class="snav-guest" data-close>Continue as guest</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    return ov;
  }
  function openSignIn() {
    var ov = ensureSignIn(); ov.classList.add('open');
    var slot = document.getElementById('snav-gbtn'); slot.innerHTML = ''; document.getElementById('snav-signin-err').textContent = '';
    if (isDev) { var b = document.createElement('button'); b.className = 'snav-btn'; b.textContent = 'Dev sign-in (local only)'; b.onclick = function () { doGoogle('dev'); }; slot.appendChild(b); return; }
    loadConfig().then(function (cfg) {
      if (!cfg.googleClientId) { document.getElementById('snav-signin-err').textContent = 'Sign-in is not configured yet.'; return; }
      loadGsi(function () { google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) { doGoogle(resp.credential); } }); google.accounts.id.renderButton(slot, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 }); });
    });
  }
  function doGoogle(credential) {
    document.getElementById('snav-signin-err').textContent = '';
    api('?action=auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: credential }) }).then(function (r) {
      if (r.ok && r.body && r.body.owner) {
        setAccount(r.body.owner);
        var ov = document.getElementById('snav-signin'); if (ov) ov.classList.remove('open');
        var cb = pendingAfterSignIn; pendingAfterSignIn = null;
        // WhatsApp-required onboarding for new/incomplete agents.
        if (!(account.profile && account.profile.waNumber)) openAccount(true);
        else if (cb) try { cb(); } catch (e) {}
      } else { document.getElementById('snav-signin-err').textContent = (r.body && r.body.error) || 'Sign-in failed.'; }
    });
  }
  function logout() { api('?action=auth/logout', { method: 'POST' }).then(function () { localStorage.removeItem('samba_mode'); location.reload(); }); }
  function requireSignIn(fn) { if (account) { fn(); return; } pendingAfterSignIn = fn; openSignIn(); }

  // ── Account sheet ──
  function ensureAccount() {
    var ov = document.getElementById('snav-account'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-account';
    ov.innerHTML = '<div class="snav-box"><div class="snav-box-head"><div class="snav-box-title">Your account</div><button class="snav-x" data-close>&times;</button></div><div class="snav-box-body" id="snav-account-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    return ov;
  }
  function openAccount(onboarding) {
    if (!account) { requireSignIn(function () { openAccount(); }); return; }
    pendingPhoto = null;
    var ov = ensureAccount(); var p = account.profile || {};
    var avPhoto = pendingPhoto || p.photo || account.picture || '';
    var mode = getMode();
    var pubLink = (p.handle && p.public) ? (location.origin + '/a/' + p.handle) : '';
    document.getElementById('snav-account-body').innerHTML =
      (onboarding ? '<div class="snav-banner">Add your WhatsApp number to finish setting up — clients use it to contact you when you share a villa.</div>' : '') +
      '<div class="snav-acct-top"><div class="snav-acct-av" id="snav-av-preview">' + (avPhoto ? '<img src="' + esc(avPhoto) + '" alt="">' : esc(initials(p.displayName || account.name))) + '<span class="snav-cam" id="snav-cam">' + I.cam + '</span></div><div class="snav-acct-id"><div class="snav-acct-name">' + esc(p.displayName || account.name || '') + '</div><div class="snav-acct-email">' + esc(account.email || '') + '</div></div></div>' +
      '<input type="file" id="snav-photo-input" accept="image/*" style="display:none">' +
      '<div class="snav-fg"><label>Display name</label><input id="snav-pf-name" value="' + esc(p.displayName || account.name || '') + '" placeholder="Your name"></div>' +
      '<div class="snav-fg"><label>Agency</label><input id="snav-pf-agency" value="' + esc(p.agency || '') + '" placeholder="e.g. Bali Homes"></div>' +
      '<div class="snav-fg"><label>WhatsApp number <span class="snav-req">*required</span></label><input id="snav-pf-wa" value="' + esc(p.waNumber || '') + '" placeholder="62812…"></div>' +
      '<label class="snav-row"><input type="checkbox" id="snav-pf-public"' + (p.public ? ' checked' : '') + '> Make my agent profile public &amp; shareable</label>' +
      (pubLink ? '<div class="snav-fg"><label>Your shareable profile</label><div class="snav-link-box">' + esc(pubLink) + '</div></div>' : '') +
      '<div class="snav-err" id="snav-pf-err"></div>' +
      '<button class="snav-btn block" id="snav-pf-save">Save profile</button>' +
      '<div class="snav-div"></div>' +
      '<div class="snav-mode"><div class="snav-mode-txt"><b>' + (mode === 'owner' ? 'Owner mode' : 'Agent mode') + '</b><span>' + (mode === 'owner' ? 'Managing your villa listings' : 'Browsing & sharing villas') + '</span></div><button class="snav-btn ghost" id="snav-mode-btn">' + I.swap + '&nbsp;Switch to ' + (mode === 'owner' ? 'Agent' : 'Owner') + '</button></div>' +
      '<a class="snav-list-link" href="/?view=shortlists">' + I.list + ' My shortlists</a>' +
      '<a class="snav-list-link" href="/portal">' + I.dashboard + ' Owner dashboard</a>' +
      '<button class="snav-list-link" id="snav-logout">' + I.out + ' Log out</button>';
    // Wire
    document.getElementById('snav-cam').onclick = function () { document.getElementById('snav-photo-input').click(); };
    document.getElementById('snav-photo-input').onchange = onPhotoPick;
    document.getElementById('snav-pf-save').onclick = function () { saveAccount(onboarding); };
    document.getElementById('snav-mode-btn').onclick = function () { setMode(mode === 'owner' ? 'agent' : 'owner'); };
    document.getElementById('snav-logout').onclick = logout;
    ov.classList.add('open');
  }
  function onPhotoPick(e) {
    var file = e.target.files && e.target.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function (ev) {
      var img = new Image();
      img.onload = function () {
        var max = 256, w = img.width, h = img.height, scale = Math.min(1, max / Math.max(w, h));
        var c = document.createElement('canvas'); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        pendingPhoto = c.toDataURL('image/jpeg', 0.82);
        var av = document.getElementById('snav-av-preview');
        if (av) av.innerHTML = '<img src="' + pendingPhoto + '" alt=""><span class="snav-cam" id="snav-cam">' + I.cam + '</span>', document.getElementById('snav-cam').onclick = function () { document.getElementById('snav-photo-input').click(); };
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }
  function saveAccount(onboarding) {
    var wa = document.getElementById('snav-pf-wa').value.trim();
    var err = document.getElementById('snav-pf-err');
    if (!wa.replace(/[^0-9]/g, '')) { err.textContent = 'A WhatsApp number is required.'; return; }
    var btn = document.getElementById('snav-pf-save'); btn.disabled = true; btn.textContent = 'Saving…';
    var payload = {
      displayName: document.getElementById('snav-pf-name').value,
      agency: document.getElementById('snav-pf-agency').value,
      waNumber: wa,
      public: document.getElementById('snav-pf-public').checked,
    };
    if (pendingPhoto) payload.photo = pendingPhoto;
    api('?action=profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Save profile';
      if (r.ok && r.body && r.body.profile) {
        account.profile = r.body.profile; pendingPhoto = null; renderTabs();
        var cb = pendingAfterSignIn; pendingAfterSignIn = null;
        document.getElementById('snav-account').classList.remove('open');
        if (onboarding && cb) try { cb(); } catch (e) {}
      } else { err.textContent = (r.body && r.body.error) || 'Could not save.'; }
    });
  }

  window.SambaNav = {
    get account() { return account; },
    isSignedIn: function () { return !!account; },
    openSignIn: openSignIn, requireSignIn: requireSignIn, openAccount: openAccount,
    onChange: function (fn) { listeners.push(fn); try { fn(account); } catch (e) {} },
    updateFavorites: function (a) { if (account) account.favorites = a; },
    refresh: loadMe, getMode: getMode, setMode: setMode,
  };

  function init() { renderTabs(); loadMe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
