/* Shared Samba account nav — two-tier:
 *   Tier 1: a permanent PORTAL SWITCH (Agent Portal ⟷ Owner Portal). Bottom bar
 *           on mobile (#snav-tabs); segmented control on desktop (in #snav-sub).
 *   Tier 2: contextual SUB-TABS for the active portal (#snav-sub, inserted right
 *           below the page .topbar):
 *             Agent  → Browse · Saved · Lists · Profile
 *             Owner  → Dashboard · List a property · Account
 * One Google login works across both portals (see api/portal.js). The active
 * portal is derived from the URL (/ = agent, /portal = owner) — no stored mode.
 *
 * window.SambaNav:
 *   .account / .isSignedIn() / .openSignIn() / .requireSignIn(fn)
 *   .openAccount() / .onChange(fn) / .updateFavorites(a) / .refresh()
 */
(function () {
  if (window.SambaNav) return;
  var API = '/api/portal';
  var isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  var account = null, listeners = [], pendingAfterSignIn = null, cfgPromise = null;
  var pendingPhoto = null; // data URL staged in the account sheet before save

  // ── Styles ──
  var css = `
  #samba-nav{display:none}
  .snav-av{width:26px;height:26px;border-radius:50%;background:#c26a4a;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:.72rem;font-weight:600}
  .snav-av img{width:100%;height:100%;object-fit:cover}
  .snav-av svg{width:16px;height:16px}
  /* Tier 2 — sub-tab strip (below the page topbar) */
  #snav-sub{display:flex;align-items:center;gap:16px;padding:8px 28px;background:#fbf9f5;border-bottom:1px solid #eee6da;overflow-x:auto;-webkit-overflow-scrolling:touch}
  #snav-sub::-webkit-scrollbar{display:none}
  .snav-seg{display:inline-flex;background:#f0ebe1;border:1px solid #e4ddcf;border-radius:11px;padding:3px;gap:2px;flex-shrink:0}
  .snav-seg-btn{display:inline-flex;align-items:center;gap:6px;border:none;background:none;font-family:'Sora',-apple-system,sans-serif;font-size:.8rem;font-weight:600;color:#7a7466;padding:7px 14px;border-radius:8px;text-decoration:none;cursor:pointer;white-space:nowrap}
  .snav-seg-btn.on{background:#fff;color:#c26a4a;box-shadow:0 1px 3px rgba(60,45,20,.12)}
  .snav-subtabs{display:inline-flex;align-items:center;gap:2px;flex-shrink:0}
  .snav-stab{display:inline-flex;align-items:center;gap:7px;border:none;background:none;font-family:'Sora',-apple-system,sans-serif;font-size:.82rem;font-weight:500;color:#6b6557;padding:8px 13px;border-radius:9px;text-decoration:none;cursor:pointer;white-space:nowrap}
  .snav-stab:hover{background:#f3efe6;color:#1a1814}
  .snav-stab.on{color:#c26a4a;background:#f7ede8}
  .snav-stab svg{width:17px;height:17px;flex-shrink:0}
  .snav-stab .snav-av{width:22px;height:22px}
  /* Tier 1 — bottom portal bar (mobile) */
  #snav-tabs{position:fixed;left:0;right:0;bottom:0;z-index:900;display:none;background:rgba(255,255,255,.97);backdrop-filter:blur(10px);border-top:1px solid #e8e2d8;padding:7px 8px calc(7px + env(safe-area-inset-bottom));gap:8px}
  #snav-tabs .snav-ptab{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;font-family:'Sora',-apple-system,sans-serif;font-size:.66rem;font-weight:600;color:#8a8478;text-decoration:none;padding:6px 4px;border-radius:12px}
  #snav-tabs .snav-ptab.on{color:#c26a4a;background:#f7ede8}
  #snav-tabs .snav-ptab svg{width:22px;height:22px}
  @media(max-width:760px){
    #snav-tabs{display:flex}
    body{padding-bottom:64px}
    #snav-sub{padding:7px 14px;gap:10px}
    #snav-sub .snav-seg{display:none}
  }
  /* Overlays (sign-in + account sheets) */
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
  .snav-btn{background:#c26a4a;color:#fff;border:none;border-radius:9px;padding:11px 16px;font-family:inherit;font-size:.85rem;font-weight:500;cursor:pointer;text-align:center;text-decoration:none;display:inline-block}
  .snav-btn:hover{background:#a55638}
  .snav-btn.block{width:100%;box-sizing:border-box}
  .snav-btn svg{width:15px;height:15px;vertical-align:-2px}
  .snav-div{height:1px;background:#eee6da;margin:4px 0}
  /* Owner subscription card */
  .snav-sub-card{background:#f3efe6;border:1px solid #e8e2d8;border-radius:12px;padding:14px}
  .snav-sub-row{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .snav-sub-plan{font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478}
  .snav-sub-status{font-size:.72rem;font-weight:600;color:#a55638;background:#f9ede7;border:1px solid #e8c9b9;padding:3px 9px;border-radius:20px;white-space:nowrap}
  .snav-sub-price{font-family:'Playfair Display',serif;font-size:1.5rem;color:#1a1814;margin-top:8px}
  .snav-sub-price span{font-family:'Sora',-apple-system,sans-serif;font-size:.8rem;color:#8a8478}
  .snav-sub-note{font-size:.78rem;color:#8a8478;line-height:1.45;margin-top:8px}
  .snav-list-link{display:flex;align-items:center;gap:10px;padding:11px 6px;font-size:.88rem;color:#1a1814;text-decoration:none;background:none;border:none;font-family:inherit;cursor:pointer;width:100%;text-align:left}
  .snav-list-link:hover{color:#c26a4a}
  .snav-list-link svg{width:17px;height:17px;color:#8a8478}
  .snav-err{color:#a8331f;font-size:.78rem;min-height:1em;text-align:center}
  `;
  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // ── Icons ──
  var I = {
    browse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-3.5-3.5"/></svg>',
    saved: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-5 0-9 2.5-9 6v1h18v-1c0-3.5-4-6-9-6Z"/></svg>',
    cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function initials(n) { return (n || 'A').trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }

  // ── Portal + sub-tab model ──
  var PORTALS = [
    { key: 'agent', label: 'Agent Portal', href: '/', icon: I.browse },
    { key: 'owner', label: 'Owner Portal', href: '/portal', icon: I.dashboard },
  ];
  function curPortal() { return /^\/portal/.test(location.pathname) ? 'owner' : 'agent'; }
  function curSub() {
    var v = new URLSearchParams(location.search).get('view');
    if (curPortal() === 'owner') return v === 'new' ? 'newlisting' : 'dashboard';
    if (v === 'saved') return 'saved';
    if (v === 'shortlists') return 'lists';
    return 'browse';
  }
  function subTabs() {
    if (curPortal() === 'owner') return [
      { key: 'dashboard', label: 'Dashboard', href: '/portal', icon: I.dashboard },
      { key: 'newlisting', label: 'List a property', act: 'newlisting', icon: I.plus },
      { key: 'account', label: 'Account', act: 'owner-account', icon: avatarIcon() },
    ];
    return [
      { key: 'browse', label: 'Browse', href: '/', icon: I.browse },
      { key: 'saved', label: 'Saved', href: '/?view=saved', icon: I.saved },
      { key: 'lists', label: 'Lists', href: '/?view=shortlists', icon: I.list },
      { key: 'profile', label: 'Profile', act: 'account', icon: avatarIcon() },
    ];
  }
  function avatarIcon() {
    if (account) {
      var ph = (account.profile && account.profile.photo) || account.picture;
      return '<span class="snav-av">' + (ph ? '<img src="' + esc(ph) + '" alt="">' : esc(initials((account.profile && account.profile.displayName) || account.name))) + '</span>';
    }
    return I.user;
  }

  // ── Render ──
  function renderNav() {
    var portal = curPortal(), sub = curSub();
    // Tier 1 — bottom portal bar (mobile)
    var bottom = document.getElementById('snav-tabs');
    if (!bottom) { bottom = document.createElement('div'); bottom.id = 'snav-tabs'; document.body.appendChild(bottom); }
    bottom.innerHTML = PORTALS.map(function (p) {
      return '<a class="snav-ptab' + (p.key === portal ? ' on' : '') + '" href="' + p.href + '">' + p.icon + '<span>' + esc(p.label) + '</span></a>';
    }).join('');
    // Tier 2 — sub-tab strip (below topbar)
    var strip = document.getElementById('snav-sub');
    if (!strip) {
      strip = document.createElement('div'); strip.id = 'snav-sub';
      var tb = document.querySelector('.topbar');
      if (tb && tb.parentNode) tb.parentNode.insertBefore(strip, tb.nextSibling);
      else document.body.insertBefore(strip, document.body.firstChild);
    }
    var seg = '<div class="snav-seg">' + PORTALS.map(function (p) {
      return '<a class="snav-seg-btn' + (p.key === portal ? ' on' : '') + '" href="' + p.href + '">' + esc(p.label) + '</a>';
    }).join('') + '</div>';
    var tabs = '<div class="snav-subtabs">' + subTabs().map(function (t) {
      var inner = t.icon + '<span>' + esc(t.label) + '</span>';
      var on = t.key === sub ? ' on' : '';
      return t.act ? '<button class="snav-stab' + on + '" data-act="' + t.act + '">' + inner + '</button>'
                   : '<a class="snav-stab' + on + '" href="' + t.href + '">' + inner + '</a>';
    }).join('') + '</div>';
    strip.innerHTML = seg + tabs;
    wire(strip); wire(bottom);
  }
  function wire(root) {
    root.querySelectorAll('[data-act]').forEach(function (el) {
      el.addEventListener('click', function () {
        var a = el.getAttribute('data-act');
        if (a === 'account') openAccount();
        else if (a === 'owner-account') openOwnerAccount();
        else if (a === 'newlisting') goNewListing();
      });
    });
  }
  function goNewListing() {
    if (/^\/portal/.test(location.pathname) && typeof window.addProperty === 'function') window.addProperty();
    else location.href = '/portal?view=new';
  }

  // ── Auth ──
  function api(path, opts) {
    return fetch(API + path, Object.assign({ credentials: 'include' }, opts || {}))
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, status: r.status, body: b }; }).catch(function () { return { ok: r.ok, status: r.status, body: null }; }); });
  }
  function loadConfig() { if (!cfgPromise) cfgPromise = api('?action=config').then(function (r) { return r.body || {}; }); return cfgPromise; }
  function setAccount(a) { account = a; renderNav(); listeners.forEach(function (fn) { try { fn(account); } catch (e) {} }); }
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
  function logout() { api('?action=auth/logout', { method: 'POST' }).then(function () { location.reload(); }); }
  function requireSignIn(fn) { if (account) { fn(); return; } pendingAfterSignIn = fn; openSignIn(); }

  // ── Agent profile sheet ──
  function ensureAccount() {
    var ov = document.getElementById('snav-account'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-account';
    ov.innerHTML = '<div class="snav-box"><div class="snav-box-head"><div class="snav-box-title">Your profile</div><button class="snav-x" data-close>&times;</button></div><div class="snav-box-body" id="snav-account-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    return ov;
  }
  function openAccount(onboarding) {
    if (!account) { requireSignIn(function () { openAccount(); }); return; }
    pendingPhoto = null;
    var ov = ensureAccount(); var p = account.profile || {};
    var avPhoto = p.photo || account.picture || '';
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
      '<button class="snav-list-link" id="snav-logout">' + I.out + ' Log out</button>';
    document.getElementById('snav-cam').onclick = function () { document.getElementById('snav-photo-input').click(); };
    document.getElementById('snav-photo-input').onchange = onPhotoPick;
    document.getElementById('snav-pf-save').onclick = function () { saveAccount(onboarding); };
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
        account.profile = r.body.profile; pendingPhoto = null; renderNav();
        var cb = pendingAfterSignIn; pendingAfterSignIn = null;
        document.getElementById('snav-account').classList.remove('open');
        if (onboarding && cb) try { cb(); } catch (e) {}
      } else { err.textContent = (r.body && r.body.error) || 'Could not save.'; }
    });
  }

  // ── Owner account / billing sheet ──
  function ensureOwnerAccount() {
    var ov = document.getElementById('snav-owner'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-owner';
    ov.innerHTML = '<div class="snav-box"><div class="snav-box-head"><div class="snav-box-title">Account</div><button class="snav-x" data-close>&times;</button></div><div class="snav-box-body" id="snav-owner-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.hasAttribute('data-close')) ov.classList.remove('open'); });
    return ov;
  }
  function openOwnerAccount() {
    if (!account) { requireSignIn(function () { openOwnerAccount(); }); return; }
    var ov = ensureOwnerAccount();
    var sub = account.subscription || null;
    var statusLabel = (sub && sub.status) ? sub.status : 'Setup in progress';
    var manage = (sub && sub.manageUrl)
      ? '<a class="snav-btn block" href="' + esc(sub.manageUrl) + '" target="_blank" rel="noopener">Manage billing</a>'
      : '<button class="snav-btn block" disabled style="opacity:.5;cursor:default">Billing management coming soon</button>';
    var avPhoto = account.picture || '';
    document.getElementById('snav-owner-body').innerHTML =
      '<div class="snav-acct-top"><div class="snav-acct-av">' + (avPhoto ? '<img src="' + esc(avPhoto) + '" alt="">' : esc(initials(account.name))) + '</div><div class="snav-acct-id"><div class="snav-acct-name">' + esc(account.name || 'Owner') + '</div><div class="snav-acct-email">' + esc(account.email || '') + '</div></div></div>' +
      '<div class="snav-sub-card"><div class="snav-sub-row"><span class="snav-sub-plan">Listing subscription</span><span class="snav-sub-status">' + esc(statusLabel) + '</span></div><div class="snav-sub-price">$10 <span>/ month per villa</span></div><div class="snav-sub-note">Your villas stay live to 250+ Bali rental agents while your subscription is active. Cancel anytime.</div></div>' +
      manage +
      '<div class="snav-div"></div>' +
      '<button class="snav-list-link" id="snav-owner-logout">' + I.out + ' Log out</button>';
    document.getElementById('snav-owner-logout').onclick = logout;
    ov.classList.add('open');
  }

  window.SambaNav = {
    get account() { return account; },
    isSignedIn: function () { return !!account; },
    openSignIn: openSignIn, requireSignIn: requireSignIn, openAccount: openAccount,
    onChange: function (fn) { listeners.push(fn); try { fn(account); } catch (e) {} },
    updateFavorites: function (a) { if (account) account.favorites = a; },
    refresh: loadMe,
  };

  function init() { renderNav(); loadMe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
