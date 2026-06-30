/* Shared Samba account nav — Airbnb-style account cluster, sign-in popup, and
 * profile editor. Self-mounts into <div id="samba-nav"> on any page. Reads auth
 * from /api/portal?action=auth/me and reuses the same Google sign-in + session
 * the owner portal uses, so one login works across the agent and owner sides.
 *
 * Exposes window.SambaNav:
 *   .account            current account object (or null)
 *   .isSignedIn()       boolean
 *   .openSignIn()       open the sign-in popup
 *   .requireSignIn(fn)  run fn() if signed in, else prompt then run on success
 *   .onChange(fn)       call fn(account) whenever auth state changes
 *   .updateFavorites(a) update the cached favourites array (after a toggle)
 *   .refresh()          re-fetch auth/me
 */
(function () {
  if (window.SambaNav) return;
  var API = '/api/portal';
  var isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  var account = null;
  var listeners = [];
  var pendingAfterSignIn = null;
  var cfgPromise = null;

  // ── Scoped styles (own palette so the nav looks identical on every page) ──
  var css = `
  #samba-nav{display:inline-flex}
  .snav{position:relative;display:inline-flex;align-items:center;gap:10px;font-family:'Sora',-apple-system,sans-serif}
  .snav-host{font-size:.8rem;font-weight:500;color:#1a1814;text-decoration:none;padding:9px 14px;border-radius:22px;white-space:nowrap;transition:background .15s}
  .snav-host:hover{background:#f3efe6}
  .snav-acct{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid #e2dccf;border-radius:22px;padding:6px 8px 6px 12px;cursor:pointer;transition:box-shadow .15s,border-color .15s}
  .snav-acct:hover{box-shadow:0 2px 8px rgba(120,90,40,.12);border-color:#d6cdbb}
  .snav-acct svg.snav-burger{width:15px;height:15px;color:#3d3a32}
  .snav-av{width:28px;height:28px;border-radius:50%;background:#c26a4a;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}
  .snav-av img{width:100%;height:100%;object-fit:cover}
  .snav-av svg{width:17px;height:17px}
  .snav-menu{position:absolute;top:calc(100% + 8px);right:0;min-width:240px;background:#fff;border:1px solid #e8e2d8;border-radius:13px;box-shadow:0 8px 28px rgba(60,45,20,.16);padding:7px;display:none;z-index:1000}
  .snav-menu.open{display:block}
  .snav-item{display:block;width:100%;text-align:left;background:none;border:none;font-family:inherit;font-size:.86rem;color:#1a1814;text-decoration:none;padding:10px 12px;border-radius:8px;cursor:pointer;box-sizing:border-box}
  .snav-item:hover{background:#f5ebe6}
  .snav-strong{font-weight:600}
  .snav-div{height:1px;background:#eee6da;margin:6px 4px}
  .snav-head{padding:8px 12px 4px}
  .snav-head-name{font-weight:600;font-size:.9rem;color:#1a1814}
  .snav-head-sub{font-size:.72rem;color:#8a8478;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* Popup + modal */
  .snav-ov{position:fixed;inset:0;background:rgba(26,24,20,.5);z-index:1100;display:none;align-items:flex-start;justify-content:center;padding:8vh 16px;overflow-y:auto}
  .snav-ov.open{display:flex}
  .snav-box{background:#fff;border:1px solid #e8e2d8;border-radius:16px;max-width:400px;width:100%;box-shadow:0 12px 40px rgba(60,45,20,.2)}
  .snav-box-head{padding:18px 22px;border-bottom:1px solid #eee6da;display:flex;align-items:center;justify-content:space-between}
  .snav-box-title{font-family:'Playfair Display',Georgia,serif;font-size:1.2rem;color:#1a1814}
  .snav-x{background:none;border:none;font-size:1.4rem;line-height:1;color:#8a8478;cursor:pointer;padding:0 4px}
  .snav-box-body{padding:20px 22px;display:flex;flex-direction:column;gap:14px}
  .snav-lede{color:#8a8478;font-size:.88rem;line-height:1.5;text-align:center}
  .snav-gbtn{display:flex;justify-content:center;min-height:44px}
  .snav-guest{display:block;width:100%;text-align:center;background:none;border:none;color:#8a8478;font-family:inherit;font-size:.82rem;cursor:pointer;padding:4px;text-decoration:underline}
  .snav-fg label{display:block;font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478;margin-bottom:6px}
  .snav-fg input{width:100%;background:#f3efe6;border:1px solid #e8e2d8;border-radius:9px;padding:11px 13px;font-family:inherit;font-size:.85rem;color:#1a1814;outline:none;box-sizing:border-box}
  .snav-fg input:focus{border-color:#c26a4a}
  .snav-row{display:flex;align-items:center;gap:9px}
  .snav-row input{width:auto}
  .snav-link-box{background:#f3efe6;border:1px solid #e8e2d8;border-radius:9px;padding:10px 12px;font-size:.78rem;color:#3d3a32;word-break:break-all}
  .snav-btn{background:#c26a4a;color:#fff;border:none;border-radius:9px;padding:11px 16px;font-family:inherit;font-size:.85rem;font-weight:500;cursor:pointer}
  .snav-btn:hover{background:#a55638}
  .snav-btn.ghost{background:#f3efe6;color:#1a1814}
  .snav-box-foot{padding:14px 22px 20px;display:flex;gap:10px;justify-content:flex-end;border-top:1px solid #eee6da}
  .snav-err{color:#a8331f;font-size:.78rem;min-height:1em;text-align:center}
  `;
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var ICON_USER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 6v1h18v-1c0-3.5-4-6-9-6Z"/></svg>';
  var ICON_BURGER = '<svg class="snav-burger" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── Mount the account cluster ──
  function mount() {
    var slot = document.getElementById('samba-nav');
    if (!slot) return;
    slot.innerHTML =
      '<div class="snav">' +
        '<a class="snav-host" href="/portal">List your villa</a>' +
        '<button class="snav-acct" id="snav-acct" aria-haspopup="true" aria-label="Account menu">' +
          ICON_BURGER + '<span class="snav-av" id="snav-av">' + ICON_USER + '</span>' +
        '</button>' +
        '<div class="snav-menu" id="snav-menu" role="menu"></div>' +
      '</div>';
    document.getElementById('snav-acct').addEventListener('click', function (e) {
      e.stopPropagation();
      document.getElementById('snav-menu').classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      var m = document.getElementById('snav-menu'), b = document.getElementById('snav-acct');
      if (m && m.classList.contains('open') && !m.contains(e.target) && !b.contains(e.target)) m.classList.remove('open');
    });
    renderMenu();
  }

  function renderMenu() {
    var m = document.getElementById('snav-menu');
    if (!m) return;
    var html;
    if (account) {
      var nm = esc((account.profile && account.profile.displayName) || account.name || account.email || 'You');
      html =
        '<div class="snav-head"><div class="snav-head-name">' + nm + '</div><div class="snav-head-sub">' + esc(account.email || '') + '</div></div>' +
        '<a class="snav-item" href="/?view=saved">Saved villas</a>' +
        '<a class="snav-item" href="/?view=shortlists">My shortlists</a>' +
        '<button class="snav-item" data-act="profile">Agent profile</button>' +
        '<div class="snav-div"></div>' +
        '<a class="snav-item" href="/portal">Owner dashboard</a>' +
        '<a class="snav-item" href="/home">Home</a>' +
        '<a class="snav-item" href="/">Browse villas</a>' +
        '<div class="snav-div"></div>' +
        '<button class="snav-item" data-act="logout">Log out</button>';
      var av = document.getElementById('snav-av');
      if (av && account.picture) av.innerHTML = '<img src="' + esc(account.picture) + '" alt="">';
    } else {
      html =
        '<button class="snav-item snav-strong" data-act="signin">Log in or sign up</button>' +
        '<div class="snav-div"></div>' +
        '<a class="snav-item" href="/portal">List your villa</a>' +
        '<a class="snav-item" href="/">Browse villas</a>' +
        '<a class="snav-item" href="/home">Home</a>';
      var av2 = document.getElementById('snav-av');
      if (av2) av2.innerHTML = ICON_USER;
    }
    m.innerHTML = html;
    m.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function () {
        var a = el.getAttribute('data-act');
        m.classList.remove('open');
        if (a === 'signin') openSignIn();
        else if (a === 'logout') logout();
        else if (a === 'profile') openProfile();
      });
    });
  }

  // ── Auth ──
  function api(path, opts) {
    return fetch(API + path, Object.assign({ credentials: 'include' }, opts || {}))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: r.ok, status: r.status, body: null }; }); });
  }
  function loadConfig() {
    if (!cfgPromise) cfgPromise = api('?action=config').then(function (r) { return r.body || {}; });
    return cfgPromise;
  }
  function setAccount(a) {
    account = a;
    renderMenu();
    listeners.forEach(function (fn) { try { fn(account); } catch (e) {} });
  }
  function loadMe() {
    return api('?action=auth/me').then(function (r) {
      setAccount(r.ok && r.body && r.body.owner ? r.body.owner : null);
      return account;
    });
  }

  function loadGsi(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    var existing = document.getElementById('snav-gsi');
    if (existing) { var t = setInterval(function () { if (window.google && google.accounts && google.accounts.id) { clearInterval(t); cb(); } }, 100); return; }
    var s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true; s.id = 'snav-gsi';
    s.onload = function () { var t = setInterval(function () { if (window.google && google.accounts && google.accounts.id) { clearInterval(t); cb(); } }, 100); };
    document.head.appendChild(s);
  }

  function ensureSignInOverlay() {
    var ov = document.getElementById('snav-signin');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'snav-ov'; ov.id = 'snav-signin';
    ov.innerHTML =
      '<div class="snav-box">' +
        '<div class="snav-box-head"><div class="snav-box-title">Welcome to Samba</div><button class="snav-x" data-close>&times;</button></div>' +
        '<div class="snav-box-body">' +
          '<p class="snav-lede">Sign in to save villas, build client shortlists, and share them.</p>' +
          '<div class="snav-gbtn" id="snav-gbtn"></div>' +
          '<div class="snav-err" id="snav-signin-err"></div>' +
          '<button class="snav-guest" data-close>Continue as guest</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    return ov;
  }

  function openSignIn() {
    var ov = ensureSignInOverlay();
    ov.classList.add('open');
    var slot = document.getElementById('snav-gbtn');
    slot.innerHTML = '';
    document.getElementById('snav-signin-err').textContent = '';
    if (isDev) {
      var b = document.createElement('button');
      b.className = 'snav-btn'; b.textContent = 'Dev sign-in (local only)';
      b.onclick = function () { doGoogle('dev-credential'); };
      slot.appendChild(b);
      return;
    }
    loadConfig().then(function (cfg) {
      if (!cfg.googleClientId) { document.getElementById('snav-signin-err').textContent = 'Sign-in is not configured yet.'; return; }
      loadGsi(function () {
        google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) { doGoogle(resp.credential); } });
        google.accounts.id.renderButton(slot, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
      });
    });
  }

  function doGoogle(credential) {
    document.getElementById('snav-signin-err').textContent = '';
    api('?action=auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: credential }) })
      .then(function (r) {
        if (r.ok && r.body && r.body.owner) {
          setAccount(r.body.owner);
          var ov = document.getElementById('snav-signin'); if (ov) ov.classList.remove('open');
          var cb = pendingAfterSignIn; pendingAfterSignIn = null;
          if (cb) try { cb(); } catch (e) {}
        } else {
          document.getElementById('snav-signin-err').textContent = (r.body && r.body.error) || 'Sign-in failed.';
        }
      });
  }

  function logout() {
    api('?action=auth/logout', { method: 'POST' }).then(function () { location.reload(); });
  }

  function requireSignIn(fn) {
    if (account) { fn(); return; }
    pendingAfterSignIn = fn;
    openSignIn();
  }

  // ── Profile editor (Agent profile) ──
  function ensureProfileOverlay() {
    var ov = document.getElementById('snav-profile');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'snav-ov'; ov.id = 'snav-profile';
    ov.innerHTML =
      '<div class="snav-box">' +
        '<div class="snav-box-head"><div class="snav-box-title">Agent profile</div><button class="snav-x" data-close>&times;</button></div>' +
        '<div class="snav-box-body">' +
          '<div class="snav-fg"><label>Display name</label><input id="snav-pf-name" placeholder="Your name"></div>' +
          '<div class="snav-fg"><label>Agency</label><input id="snav-pf-agency" placeholder="e.g. Bali Homes"></div>' +
          '<div class="snav-fg"><label>WhatsApp number</label><input id="snav-pf-wa" placeholder="62812…"></div>' +
          '<label class="snav-row"><input type="checkbox" id="snav-pf-public"> <span style="font-size:.85rem;color:#3d3a32">Make my profile public &amp; shareable</span></label>' +
          '<div id="snav-pf-linkwrap" style="display:none"><label style="font-size:.66rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478">Your shareable link</label><div class="snav-link-box" id="snav-pf-link"></div></div>' +
          '<div class="snav-err" id="snav-pf-err"></div>' +
        '</div>' +
        '<div class="snav-box-foot"><button class="snav-btn ghost" data-close>Close</button><button class="snav-btn" id="snav-pf-save">Save</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    document.getElementById('snav-pf-save').addEventListener('click', saveProfile);
    return ov;
  }

  function openProfile() {
    if (!account) { requireSignIn(openProfile); return; }
    var ov = ensureProfileOverlay();
    var p = account.profile || {};
    document.getElementById('snav-pf-name').value = p.displayName || account.name || '';
    document.getElementById('snav-pf-agency').value = p.agency || '';
    document.getElementById('snav-pf-wa').value = p.waNumber || '';
    document.getElementById('snav-pf-public').checked = !!p.public;
    document.getElementById('snav-pf-err').textContent = '';
    renderProfileLink(p);
    ov.classList.add('open');
  }

  function renderProfileLink(p) {
    var wrap = document.getElementById('snav-pf-linkwrap');
    if (p && p.handle && p.public) {
      document.getElementById('snav-pf-link').textContent = location.origin + '/a/' + p.handle;
      wrap.style.display = 'block';
    } else { wrap.style.display = 'none'; }
  }

  function saveProfile() {
    var btn = document.getElementById('snav-pf-save'); btn.disabled = true; btn.textContent = 'Saving…';
    var payload = {
      displayName: document.getElementById('snav-pf-name').value,
      agency: document.getElementById('snav-pf-agency').value,
      waNumber: document.getElementById('snav-pf-wa').value,
      public: document.getElementById('snav-pf-public').checked,
    };
    api('?action=profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) {
        btn.disabled = false; btn.textContent = 'Save';
        if (r.ok && r.body && r.body.profile) {
          account.profile = r.body.profile;
          renderProfileLink(r.body.profile);
          renderMenu();
        } else {
          document.getElementById('snav-pf-err').textContent = (r.body && r.body.error) || 'Could not save.';
        }
      });
  }

  // ── Public API ──
  window.SambaNav = {
    get account() { return account; },
    isSignedIn: function () { return !!account; },
    openSignIn: openSignIn,
    requireSignIn: requireSignIn,
    openProfile: openProfile,
    onChange: function (fn) { listeners.push(fn); if (account !== undefined) try { fn(account); } catch (e) {} },
    updateFavorites: function (arr) { if (account) account.favorites = arr; },
    refresh: loadMe,
  };

  function init() { mount(); loadMe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
