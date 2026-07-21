/* Shared Samba account nav — two-tier:
 *   Tier 1: a permanent PORTAL SWITCH (Agent portal ⟷ Owner portal). Bottom bar
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
  var sigSource = 'nav';   // which surface opened sign-in: nav | gate | auto | onetap
  var oneTapTried = false;
  var oneTapAt = 0;        // when we last asked Google to show One Tap (for prompt sequencing)

  // Fire-and-forget funnel events (event names must match /^[a-z_]{1,32}$/).
  function snTrack(event) {
    try {
      fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event: event }) }).catch(function () {});
    } catch (e) {}
  }

  // Google blocks OAuth inside embedded webviews (403 disallowed_useragent),
  // and One Tap/FedCM can freeze silently there. WhatsApp/IG/FB in-app
  // browsers are common for our agents, so detect and route around it.
  function isInAppBrowser() {
    var ua = navigator.userAgent || '';
    return /\bwv\b|FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|; ?wv\)/i.test(ua);
  }

  // ── Styles ──
  var css = `
  #samba-nav{display:flex;flex:1;min-width:0;justify-content:flex-end}
  #snav-sub.inline{padding:0;margin:0;max-width:none;flex:1;min-width:0;justify-content:flex-end}
  #snav-sub.inline .snav-stab{padding:7px 9px}
  @media(max-width:640px){
    /* Icon-only tabs on mobile — but keep .snav-av: it IS the icon for the
       signed-in Profile/Account tab (hiding it made the tab vanish). */
    #snav-sub.inline .snav-stab span:not(.snav-av){display:none}
    #snav-sub.inline .snav-stab{padding:9px}
    #snav-sub.inline .snav-stab svg{width:19px;height:19px}
  }
  .snav-av{width:26px;height:26px;border-radius:50%;background:#C46E4B;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;font-size:.72rem;font-weight:600}
  .snav-av img{width:100%;height:100%;object-fit:cover}
  .snav-av svg{width:16px;height:16px}
  /* Tier 2 — sub-tab strip (below the page topbar), quiet pills on the page bg */
  #snav-sub{display:flex;align-items:center;gap:12px;padding:10px 20px 0;background:transparent;border:none;overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:960px;margin:0 auto;box-sizing:border-box}
  #snav-sub::-webkit-scrollbar{display:none}
  .snav-seg{display:inline-flex;background:#fff;border:1px solid rgba(28,25,23,.09);border-radius:999px;padding:3px;gap:2px;flex-shrink:0;box-shadow:0 1px 2px rgba(28,25,23,.07),0 2px 5px rgba(28,25,23,.05)}
  .snav-seg-btn{display:inline-flex;align-items:center;gap:6px;border:none;background:none;font-family:'Geist',-apple-system,sans-serif;font-size:.76rem;font-weight:600;letter-spacing:.01em;color:#8a8478;padding:7px 14px;border-radius:999px;text-decoration:none;cursor:pointer;white-space:nowrap;transition:background .18s cubic-bezier(.2,.8,.2,1),color .18s cubic-bezier(.2,.8,.2,1)}
  .snav-seg-btn.on{background:#F6E7DE;color:#C46E4B}
  .snav-subtabs{display:inline-flex;align-items:center;gap:2px;flex-shrink:0}
  .snav-stab{display:inline-flex;align-items:center;gap:6px;border:none;background:none;font-family:'Geist',-apple-system,sans-serif;font-size:.78rem;font-weight:500;letter-spacing:.01em;color:#6b6557;padding:8px 12px;border-radius:999px;text-decoration:none;cursor:pointer;white-space:nowrap;transition:background .18s cubic-bezier(.2,.8,.2,1),color .18s cubic-bezier(.2,.8,.2,1)}
  .snav-stab:hover{background:#F5F1EB;color:#1C1917}
  .snav-stab.on{color:#C46E4B;background:#F6E7DE}
  .snav-stab svg{width:16px;height:16px;flex-shrink:0}
  .snav-stab .snav-av{width:22px;height:22px}
  /* Tier 1 — floating glass portal bar (mobile) */
  #snav-tabs{position:fixed;left:16px;right:16px;bottom:14px;z-index:900;display:none;background:rgba(255,255,255,.92);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border:1px solid rgba(28,25,23,.09);border-radius:22px;padding:5px;gap:8px;height:62px;box-sizing:border-box;box-shadow:0 1px 2px rgba(28,25,23,.06),0 8px 22px rgba(28,25,23,.1)}
  #snav-tabs .snav-ptab{flex:1;position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font-family:'Geist',-apple-system,sans-serif;font-size:.7rem;font-weight:600;letter-spacing:.01em;color:#8a8478;text-decoration:none;padding:4px;border-radius:18px;transition:background .18s cubic-bezier(.2,.8,.2,1),color .18s cubic-bezier(.2,.8,.2,1)}
  #snav-tabs .snav-ptab+.snav-ptab::before{content:'';position:absolute;left:-4.5px;top:24%;height:52%;width:1px;background:#F1ECE7}
  #snav-tabs .snav-ptab.on{color:#C46E4B;background:#F6E7DE}
  #snav-tabs .snav-ptab svg{width:18px;height:18px}
  @media(max-width:760px){
    #snav-tabs{display:flex}
    body{padding-bottom:96px}
    #snav-sub{padding:8px 16px 0;gap:8px}
    #snav-sub .snav-seg{display:none}
  }
  /* Overlays (sign-in + account sheets) — animated in/out, blurred scrim */
  .snav-ov{position:fixed;inset:0;background:rgba(28,25,23,.45);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);z-index:1100;display:flex;align-items:flex-start;justify-content:center;padding:7vh 16px;overflow-y:auto;opacity:0;visibility:hidden;transition:opacity .22s ease,visibility 0s linear .22s}
  .snav-ov.open{opacity:1;visibility:visible;transition:opacity .22s ease}
  .snav-box{background:#fff;border:none;border-radius:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.16);transform:translateY(14px) scale(.97);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
  .snav-ov.open .snav-box{transform:none}
  .snav-box-head{padding:18px 22px;border-bottom:1px solid #F1ECE7;display:flex;align-items:center;justify-content:space-between}
  .snav-box-title{font-family:'Geist',-apple-system,sans-serif;font-weight:650;font-size:1.15rem;color:#1C1917;letter-spacing:-.01em}
  .snav-x{background:none;border:none;font-size:1.5rem;line-height:1;color:#8a8478;cursor:pointer;padding:0 4px}
  .snav-box-body{padding:20px 22px;display:flex;flex-direction:column;gap:14px}
  .snav-lede{color:#8a8478;font-size:.88rem;line-height:1.6;text-align:center}
  .snav-benefits{list-style:none;margin:2px 0 6px;padding:0;display:flex;flex-direction:column;gap:11px}
  .snav-benefits li{display:flex;gap:12px;align-items:flex-start;font-size:.84rem;line-height:1.5;color:#514C45}
  .snav-benefits li b{color:#1C1917}
  .snav-benefits .snav-bicon{flex-shrink:0;width:28px;height:28px;border-radius:9px;background:#F6E7DE;color:#B8613F;display:flex;align-items:center;justify-content:center}
  .snav-benefits .snav-bicon svg{width:14px;height:14px}
  .snav-gbtn{display:flex;justify-content:center;min-height:44px}
  .snav-guest{display:block;width:100%;text-align:center;background:none;border:none;color:#8a8478;font-family:'Geist',-apple-system,sans-serif;font-size:.8rem;font-weight:500;cursor:pointer;padding:8px 4px;transition:color .18s ease}
  .snav-guest:hover{color:#514C45}
  /* Sign-in modal — hero layout */
  .snav-si-box{position:relative}
  .snav-x-float{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;background:#F5F1EB;border:none;color:#8a8478;font-size:1.25rem;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;z-index:2;transition:color .18s ease,background .18s ease}
  .snav-x-float:hover{color:#1C1917;background:#F1ECE7}
  .snav-si-hero{padding:32px 26px 0;display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px}
  .snav-si-mark{width:52px;height:52px;border-radius:15px;overflow:hidden;box-shadow:0 1px 2px rgba(28,25,23,.08),0 6px 16px rgba(28,25,23,.12)}
  .snav-si-mark img{width:100%;height:100%;display:block}
  .snav-si-title{font-family:'Geist',-apple-system,sans-serif;font-weight:650;font-size:1.3rem;color:#1C1917;letter-spacing:-.02em}
  .snav-si-lede{color:#8a8478;font-size:.86rem;line-height:1.6;margin:-4px 0 0;max-width:300px}
  .snav-wait{display:flex;align-items:center;justify-content:center;gap:9px;min-height:44px;font-size:.84rem;color:#514C45}
  .snav-spin{width:16px;height:16px;border:2px solid rgba(196,110,75,.22);border-top-color:#C46E4B;border-radius:50%;animation:snavspin .7s linear infinite;flex-shrink:0}
  @keyframes snavspin{to{transform:rotate(360deg)}}
  .snav-fineprint{text-align:center;font-size:.7rem;color:#b3ac9f;line-height:1.5;margin-top:-4px}
  /* Onboarding welcome hero (account sheet, new sign-ups) */
  .snav-welcome{display:flex;flex-direction:column;align-items:center;text-align:center;gap:10px;padding:6px 0 2px}
  .snav-welcome .snav-acct-av{width:64px;height:64px;box-shadow:0 1px 2px rgba(28,25,23,.08),0 6px 16px rgba(28,25,23,.12)}
  .snav-step{font-size:.66rem;letter-spacing:.12em;text-transform:uppercase;color:#C46E4B;font-weight:650}
  .snav-welcome-title{font-family:'Geist',-apple-system,sans-serif;font-weight:650;font-size:1.25rem;color:#1C1917;letter-spacing:-.02em;margin-top:2px}
  .snav-welcome-sub{font-size:.84rem;color:#8a8478;line-height:1.6;max-width:300px}
  /* Toast — quiet confirmation pill */
  .snav-toast{position:fixed;left:50%;bottom:92px;transform:translate(-50%,10px);background:#1C1917;color:#fff;padding:11px 20px;border-radius:999px;font-family:'Geist',-apple-system,sans-serif;font-size:.8rem;font-weight:500;z-index:1300;opacity:0;pointer-events:none;display:flex;align-items:center;gap:9px;box-shadow:0 10px 30px rgba(28,25,23,.25);white-space:nowrap;transition:opacity .25s ease,transform .25s cubic-bezier(.2,.8,.2,1)}
  .snav-toast.show{opacity:1;transform:translate(-50%,0)}
  .snav-toast .snav-spin{border-color:rgba(255,255,255,.25);border-top-color:#fff}
  .snav-inapp{background:#F6E7DE;border-radius:10px;padding:12px 14px;font-size:.82rem;line-height:1.55;color:#514C45}
  .snav-handoff{width:100%;display:flex;flex-direction:column;gap:10px}
  .snav-acct-top{display:flex;align-items:center;gap:13px}
  .snav-acct-av{width:58px;height:58px;border-radius:50%;background:#C46E4B;color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-family:'Geist',-apple-system,sans-serif;font-weight:650;font-size:1.3rem;flex-shrink:0;position:relative}
  .snav-acct-av img{width:100%;height:100%;object-fit:cover}
  .snav-cam{position:absolute;right:-2px;bottom:-2px;width:24px;height:24px;border-radius:50%;background:#fff;border:1px solid #F1ECE7;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#514C45;box-shadow:0 2px 6px rgba(0,0,0,.08)}
  .snav-cam svg{width:13px;height:13px}
  .snav-acct-id{min-width:0}
  .snav-acct-name{font-family:'Geist',-apple-system,sans-serif;font-weight:650;font-size:1.1rem;color:#1C1917}
  .snav-acct-email{font-size:.74rem;color:#8a8478;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .snav-fg label{display:block;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478;margin-bottom:6px;font-weight:600}
  .snav-req{color:#C46E4B}
  .snav-fg input{width:100%;background:#F5F1EB;border:1px solid transparent;border-radius:13px;padding:12px 14px;font-family:inherit;font-size:.85rem;color:#1C1917;outline:none;box-sizing:border-box}
  .snav-fg input:focus{border-color:#C46E4B;background:#fff}
  .snav-row{display:flex;align-items:center;gap:9px;font-size:.85rem;color:#514C45}
  .snav-row input{width:auto}
  .snav-link-box{background:#F5F1EB;border:none;border-radius:13px;padding:10px 13px;font-size:.76rem;color:#514C45;word-break:break-all}
  .snav-btn{background:#C46E4B;color:#fff;border:none;border-radius:14px;padding:13px 18px;font-family:inherit;font-size:.85rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;display:inline-block;box-shadow:0 4px 12px rgba(0,0,0,.08);transition:background .18s cubic-bezier(.2,.8,.2,1)}
  .snav-btn:hover{background:#B8613F}
  .snav-btn:active{background:#A85737}
  .snav-btn.block{width:100%;box-sizing:border-box}
  .snav-btn svg{width:15px;height:15px;vertical-align:-2px}
  .snav-div{height:1px;background:#F1ECE7;margin:4px 0}
  /* Owner subscription card */
  .snav-sub-card{background:#F5F1EB;border:none;border-radius:18px;padding:16px}
  .snav-sub-row{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .snav-sub-plan{font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;color:#8a8478;font-weight:600}
  .snav-sub-status{font-size:.72rem;font-weight:600;color:#B8613F;background:#F6E7DE;border:none;padding:4px 11px;border-radius:999px;white-space:nowrap}
  .snav-sub-price{font-family:'Geist',-apple-system,sans-serif;font-weight:700;font-size:1.5rem;color:#1C1917;margin-top:8px;letter-spacing:-.02em}
  .snav-sub-price span{font-size:.8rem;color:#8a8478;font-weight:500}
  .snav-sub-note{font-size:.78rem;color:#8a8478;line-height:1.5;margin-top:8px}
  .snav-list-link{display:flex;align-items:center;gap:10px;padding:11px 6px;font-size:.88rem;color:#1C1917;text-decoration:none;background:none;border:none;font-family:inherit;cursor:pointer;width:100%;text-align:left}
  .snav-list-link:hover{color:#C46E4B}
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
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function initials(n) { return (n || 'A').trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }

  // ── Portal + sub-tab model ──
  var PORTALS = [
    { key: 'agent', label: 'Agent portal', href: '/', icon: I.person },
    { key: 'owner', label: 'Owner portal', href: '/portal', icon: I.dashboard },
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
    // Tier 2 — sub-tab strip. Preferred mount is INSIDE the topbar row (via
    // the #samba-nav slot) so the logo and tabs share one line; falls back to
    // a full-width strip below the topbar on pages without the slot.
    var strip = document.getElementById('snav-sub');
    if (!strip) {
      strip = document.createElement('div'); strip.id = 'snav-sub';
      var host = document.getElementById('samba-nav');
      var tb = document.querySelector('.topbar');
      if (host) { strip.className = 'inline'; host.appendChild(strip); }
      else if (tb && tb.parentNode) tb.parentNode.insertBefore(strip, tb.nextSibling);
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
  function loadMe() { return api('?action=auth/me').then(function (r) { setAccount(r.ok && r.body && r.body.owner ? r.body.owner : null); if (!account && !maybeHandoff() && !maybeLandingPrompt()) maybeOneTap(); return account; }); }

  // Landing on the agent portal signed out: open the full sign-in sheet once
  // the grid has painted behind it — a richer welcome than One Tap. Shown once
  // per session; within the session One Tap, the contextual gates and the
  // engagement-cadence prompt take over. Returns true when it claims this page
  // load (so One Tap stays quiet).
  function maybeLandingPrompt() {
    if (curPortal() !== 'agent') return false;   // owner portal has its own flow
    // In-app browsers (most WhatsApp arrivals) get the sheet too — its CTA
    // there is the browser-escape hop rather than the Google button.
    try {
      if (sessionStorage.getItem('samba_landing_prompted')) return false;
      sessionStorage.setItem('samba_landing_prompted', '1');
      sessionStorage.setItem('samba_sp_sess', '1');  // villa-close prompt stays quiet this session
    } catch (e) { return false; }
    setTimeout(function () { if (!account) openSignIn('landing'); }, 1400);
    return true;
  }

  function loadGsi(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    var s = document.getElementById('snav-gsi');
    if (!s) { s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.id = 'snav-gsi'; document.head.appendChild(s); }
    var t = setInterval(function () { if (window.google && google.accounts && google.accounts.id) { clearInterval(t); cb(); } }, 100);
  }
  // Contextual headlines: the gate that opened the modal names the value the
  // agent was reaching for, instead of a generic welcome pitch.
  var SIGNIN_COPY = {
    favorite:  { title: 'Save this villa',          lede: 'Sign in to keep favourites and private notes on every device.' },
    shortlist: { title: 'Build a client shortlist', lede: 'Sign in to pick villas and send your client one polished link.' },
    'default': { title: 'Welcome to Samba',         lede: 'One account for favourites, shortlists and your public agent profile.' }
  };
  function ensureSignIn() {
    var ov = document.getElementById('snav-signin'); if (ov) return ov;
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-signin';
    ov.innerHTML = '<div class="snav-box snav-si-box"><button class="snav-x-float" data-close aria-label="Close">&times;</button>' +
      '<div class="snav-si-hero"><div class="snav-si-mark"><img src="/icon-192.png" alt=""></div>' +
      '<div class="snav-si-title" id="snav-si-title">Welcome to Samba</div>' +
      '<p class="snav-si-lede" id="snav-si-lede">One account for favourites, shortlists and your public agent profile.</p></div>' +
      '<div class="snav-box-body">' +
      '<ul class="snav-benefits">' +
      '<li><span class="snav-bicon">' + I.person + '</span><span><b>Clients enquire with you</b> — every villa you share carries your name, photo and WhatsApp</span></li>' +
      '<li><span class="snav-bicon">' + I.saved + '</span><span><b>Favourites &amp; private notes</b> — synced on every device</span></li>' +
      '<li><span class="snav-bicon">' + I.list + '</span><span><b>Client shortlists</b> — pick villas, send one link</span></li>' +
      '</ul>' +
      '<div class="snav-gbtn" id="snav-gbtn"></div>' +
      '<div class="snav-wait" id="snav-signin-wait" style="display:none"><span class="snav-spin"></span> Signing you in…</div>' +
      '<div class="snav-err" id="snav-signin-err"></div>' +
      '<div class="snav-fineprint">Free for agents · no card required</div>' +
      '<button class="snav-guest" data-close>Continue as guest</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      if (e.target === ov || e.target.hasAttribute('data-close')) {
        ov.classList.remove('open');
        if (!account) snTrack('signup_dismissed_' + sigSource);
      }
    });
    return ov;
  }
  function openSignIn(src, ctx) {
    sigSource = src || 'nav';
    var ov = ensureSignIn(); ov.classList.add('open');
    var copy = SIGNIN_COPY[ctx] || SIGNIN_COPY['default'];
    document.getElementById('snav-si-title').textContent = copy.title;
    document.getElementById('snav-si-lede').textContent = copy.lede;
    var slot = document.getElementById('snav-gbtn'); slot.innerHTML = ''; slot.style.display = '';
    document.getElementById('snav-signin-wait').style.display = 'none';
    document.getElementById('snav-signin-err').textContent = '';
    snTrack('signup_shown_' + sigSource);
    if (isInAppBrowser()) {
      // Google blocks OAuth inside embedded webviews (403 disallowed_useragent),
      // so the primary CTA hops to the real browser, which reopens this sheet
      // on arrival (?signin=1 → maybeHandoff). Manual instructions only appear
      // if the hop is blocked.
      slot.innerHTML = '<div class="snav-handoff">' +
        '<button class="snav-btn block" id="snav-inapp-open">Continue in your browser</button>' +
        '<div class="snav-fineprint">Google sign-in opens in your phone\'s browser — you\'ll land right back here.</div>' +
        '<div class="snav-inapp" id="snav-inapp-help" style="display:none">Nothing opened? Tap the <b>⋮</b> or share menu and choose <b>Open in browser</b>, then sign in there.<br><br><button class="snav-btn block" id="snav-copylink">Copy page link</button></div></div>';
      document.getElementById('snav-inapp-open').onclick = escapeInApp;
      document.getElementById('snav-copylink').onclick = function () {
        try { navigator.clipboard.writeText(location.href); this.textContent = 'Link copied ✓'; } catch (e) {}
      };
      snTrack('signup_inapp_blocked');
      return;
    }
    if (isDev) { var b = document.createElement('button'); b.className = 'snav-btn'; b.textContent = 'Dev sign-in (local only)'; b.onclick = function () { doGoogle('dev'); }; slot.appendChild(b); return; }
    loadConfig().then(function (cfg) {
      if (!cfg.googleClientId) { document.getElementById('snav-signin-err').textContent = 'Sign-in is not configured yet.'; return; }
      loadGsi(function () {
        google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) { doGoogle(resp.credential); } });
        // Outline theme sits quietly in the warm palette (filled_blue fought it);
        // width tracks the modal so the button never floats undersized.
        var w = Math.max(240, Math.min(400, slot.clientWidth || 320));
        google.accounts.id.renderButton(slot, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', logo_alignment: 'center', width: w });
      });
    });
  }

  // Break out of the in-app webview into the real browser, carrying ?signin=1
  // so the sheet reopens on arrival. Android: an intent:// URL reaches the
  // default browser from most webviews (incl. WhatsApp's). iOS: the x-safari-
  // scheme does the same for Safari. If the page is still visible after a
  // beat the hop was blocked — reveal the manual instructions instead.
  function escapeInApp() {
    snTrack('signup_inapp_escape');
    var u = new URL(location.href);
    u.searchParams.set('signin', '1');
    u.hash = '';
    var bare = u.href.replace(/^https?:\/\//, '');
    if (/Android/i.test(navigator.userAgent)) {
      location.href = 'intent://' + bare + '#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=' + encodeURIComponent(u.href) + ';end';
    } else {
      location.href = 'x-safari-https://' + bare;
    }
    // Default to revealing the manual fallback; cancel only if the page went
    // to background (= the browser actually opened). Safer than requiring a
    // 'visible' report, which some webviews get wrong.
    var fallbackTimer = setTimeout(function () {
      snTrack('signup_inapp_escape_fail');
      var help = document.getElementById('snav-inapp-help');
      if (help) help.style.display = '';
    }, 1600);
    document.addEventListener('visibilitychange', function onVis() {
      if (document.visibilityState !== 'hidden') return;
      clearTimeout(fallbackTimer);
      document.removeEventListener('visibilitychange', onVis);
    });
  }

  // Arrival from an in-app escape: ?signin=1 means the visitor already chose
  // to sign in — reopen the sheet immediately and strip the flag from the URL.
  function maybeHandoff() {
    var sp = new URLSearchParams(location.search);
    if (sp.get('signin') !== '1') return false;
    sp.delete('signin');
    try { history.replaceState(null, '', location.pathname + (sp.toString() ? '?' + sp.toString() : '') + location.hash); } catch (e) {}
    try { sessionStorage.setItem('samba_landing_prompted', '1'); sessionStorage.setItem('samba_sp_sess', '1'); } catch (e) {}
    setTimeout(function () { if (!account) openSignIn('handoff'); }, 400);
    return true;
  }

  // Google One Tap for guests: a small non-blocking card with the agent's own
  // Google account — one tap to sign in, no modal. Google handles the show/
  // dismiss cadence itself (escalating cooldowns after each dismissal).
  function maybeOneTap() {
    if (oneTapTried || account || isDev || isInAppBrowser()) return;
    oneTapTried = true;
    try { if (Date.now() < +(localStorage.getItem('samba_onetap_snooze') || 0)) return; } catch (e) {}
    loadConfig().then(function (cfg) {
      if (!cfg.googleClientId) return;
      loadGsi(function () {
        if (account) return;
        oneTapAt = Date.now();
        google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: function (resp) { sigSource = 'onetap'; doGoogle(resp.credential); } });
        google.accounts.id.prompt();
      });
    });
  }
  // Transient confirmation pill (welcome back, profile saved, signing in…).
  var toastEl = null, toastTimer = null;
  function snToast(html, ms) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'snav-toast'; document.body.appendChild(toastEl); }
    toastEl.innerHTML = html;
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2600);
  }
  function hideToast() { if (toastEl) toastEl.classList.remove('show'); clearTimeout(toastTimer); }
  function firstName() {
    var p = account && account.profile;
    return (((p && p.displayName) || (account && account.name) || '').trim().split(/\s+/)[0]) || '';
  }
  function doGoogle(credential) {
    var ov = document.getElementById('snav-signin');
    var inModal = !!(ov && ov.classList.contains('open'));
    // Visible progress between the Google tap and our server round-trip —
    // dead air here reads as broken on slow connections.
    if (inModal) {
      document.getElementById('snav-signin-err').textContent = '';
      document.getElementById('snav-gbtn').style.display = 'none';
      document.getElementById('snav-signin-wait').style.display = 'flex';
    } else snToast('<span class="snav-spin"></span> Signing you in…', 15000);
    api('?action=auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: credential }) }).then(function (r) {
      if (r.ok && r.body && r.body.owner) {
        setAccount(r.body.owner);
        snTrack(r.body.isNew ? 'signup_done_' + sigSource : 'signin_done');
        if (ov) ov.classList.remove('open');
        var cb = pendingAfterSignIn; pendingAfterSignIn = null;
        // WhatsApp-required onboarding for new/incomplete agents.
        if (!(account.profile && account.profile.waNumber)) { hideToast(); openAccount(true); }
        else {
          var f = firstName();
          snToast('Welcome back' + (f ? ', ' + esc(f) : ''));
          if (cb) try { cb(); } catch (e) {}
        }
      } else {
        var msg = (r.body && r.body.error) || 'Sign-in failed.';
        if (inModal) {
          document.getElementById('snav-signin-wait').style.display = 'none';
          document.getElementById('snav-gbtn').style.display = '';
          document.getElementById('snav-signin-err').textContent = msg;
        } else snToast(esc(msg));
      }
    });
  }
  function logout() {
    // Don't One Tap someone who just chose to log out — snooze it for a day.
    try { localStorage.setItem('samba_onetap_snooze', String(Date.now() + 864e5)); } catch (e) {}
    api('?action=auth/logout', { method: 'POST' }).then(function () { location.reload(); });
  }
  function requireSignIn(fn, ctx) { if (account) { fn(); return; } pendingAfterSignIn = fn; openSignIn('gate', ctx); }

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
    var ttl = ov.querySelector('.snav-box-title'); if (ttl) ttl.textContent = onboarding ? 'Welcome to Samba' : 'Your profile';
    var avPhoto = p.photo || account.picture || '';
    var pubLink = (p.handle && p.public) ? (location.origin + '/a/' + p.handle) : '';
    var avInner = (avPhoto ? '<img src="' + esc(avPhoto) + '" alt="">' : esc(initials(p.displayName || account.name))) + '<span class="snav-cam" id="snav-cam">' + I.cam + '</span>';
    // Onboarding gets a welcome moment (their own name and photo, one clear
    // next step) instead of the settings-sheet header with a warning banner.
    document.getElementById('snav-account-body').innerHTML =
      (onboarding
        ? '<div class="snav-welcome"><div class="snav-acct-av" id="snav-av-preview">' + avInner + '</div>' +
          '<div><div class="snav-step">Step 2 of 2</div><div class="snav-welcome-title">Welcome' + (firstName() ? ', ' + esc(firstName()) : '') + '</div></div>' +
          '<div class="snav-welcome-sub">You\'re in — this is your agent card. Add your WhatsApp number so clients can reach you about villas you share.</div></div>'
        : '<div class="snav-acct-top"><div class="snav-acct-av" id="snav-av-preview">' + avInner + '</div><div class="snav-acct-id"><div class="snav-acct-name">' + esc(p.displayName || account.name || '') + '</div><div class="snav-acct-email">' + esc(account.email || '') + '</div></div></div>') +
      '<input type="file" id="snav-photo-input" accept="image/*" style="display:none">' +
      '<div class="snav-fg"><label>Display name</label><input id="snav-pf-name" value="' + esc(p.displayName || account.name || '') + '" placeholder="Your name"></div>' +
      '<div class="snav-fg"><label>Agency</label><input id="snav-pf-agency" value="' + esc(p.agency || '') + '" placeholder="e.g. Bali Homes"></div>' +
      '<div class="snav-fg"><label>WhatsApp number <span class="snav-req">*required</span></label><input id="snav-pf-wa" value="' + esc(p.waNumber || '') + '" placeholder="62812…"></div>' +
      '<label class="snav-row"><input type="checkbox" id="snav-pf-public"' + (p.public ? ' checked' : '') + '> Make my agent profile public &amp; shareable</label>' +
      (pubLink ? '<div class="snav-fg"><label>Your shareable profile</label><div class="snav-link-box">' + esc(pubLink) + '</div></div>' : '') +
      '<div class="snav-fg" id="snav-mystats" style="display:none"></div>' +
      '<div class="snav-err" id="snav-pf-err"></div>' +
      '<button class="snav-btn block" id="snav-pf-save">' + (onboarding ? 'Finish setup' : 'Save profile') + '</button>' +
      '<div class="snav-div"></div>' +
      '<button class="snav-list-link" id="snav-logout">' + I.out + ' Log out</button>';
    document.getElementById('snav-cam').onclick = function () { document.getElementById('snav-photo-input').click(); };
    document.getElementById('snav-photo-input').onchange = onPhotoPick;
    document.getElementById('snav-pf-save').onclick = function () { saveAccount(onboarding); };
    document.getElementById('snav-logout').onclick = logout;
    // Share performance — the agent's own attribution numbers, when any exist.
    api('?action=my-stats').then(function (r) {
      var s = r.ok && r.body && r.body.stats;
      if (!s || (!s.views && !s.enquiries)) return;
      var el = document.getElementById('snav-mystats'); if (!el) return;
      el.style.display = '';
      el.innerHTML = '<label>Your share performance</label><div class="snav-link-box"><b>' + s.views + '</b> link open' + (s.views === 1 ? '' : 's') + ' · <b>' + s.enquiries + '</b> WhatsApp enquir' + (s.enquiries === 1 ? 'y' : 'ies') + ' from your shares' + ((s.viewsThisMonth || s.enquiriesThisMonth) ? ' <span style="color:#8a8478">(' + s.viewsThisMonth + ' · ' + s.enquiriesThisMonth + ' this month)</span>' : '') + '</div>';
    });
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
    var label = onboarding ? 'Finish setup' : 'Save profile';
    var btn = document.getElementById('snav-pf-save'); btn.disabled = true; btn.textContent = 'Saving…';
    var payload = {
      displayName: document.getElementById('snav-pf-name').value,
      agency: document.getElementById('snav-pf-agency').value,
      waNumber: wa,
      public: document.getElementById('snav-pf-public').checked,
    };
    if (pendingPhoto) payload.photo = pendingPhoto;
    api('?action=profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (r) {
      btn.disabled = false; btn.textContent = label;
      if (r.ok && r.body && r.body.profile) {
        account.profile = r.body.profile; pendingPhoto = null; renderNav();
        var cb = pendingAfterSignIn; pendingAfterSignIn = null;
        document.getElementById('snav-account').classList.remove('open');
        snToast(onboarding ? 'You\'re all set' + (firstName() ? ', ' + esc(firstName()) : '') : 'Profile saved');
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
      '<div class="snav-sub-card"><div class="snav-sub-row"><span class="snav-sub-plan">Listing subscription</span><span class="snav-sub-status">' + esc(statusLabel) + '</span></div><div class="snav-sub-price">IDR 150k <span>/ month per villa</span></div><div class="snav-sub-note">Your villas stay live to 250+ Bali rental agents while your subscription is active. Cancel anytime.</div></div>' +
      manage +
      '<div class="snav-div"></div>' +
      '<button class="snav-list-link" id="snav-owner-logout">' + I.out + ' Log out</button>';
    document.getElementById('snav-owner-logout').onclick = logout;
    ov.classList.add('open');
  }

  // True while any sign-in surface could be on screen: our sheets, or Google
  // One Tap within a grace window of prompting it (FedCM One Tap is browser
  // UI with no DOM we can query, so we also check the classic container ids).
  // Other prompts (e.g. the install banner) use this to avoid stacking.
  function signInSurfaceActive() {
    if (!account && oneTapAt && Date.now() - oneTapAt < 25000) return true;
    if (document.querySelector('.snav-ov.open')) return true;
    var el = document.getElementById('credential_picker_container') || document.getElementById('credential_picker_iframe');
    return !!(el && (el.offsetWidth || el.offsetHeight));
  }

  window.SambaNav = {
    get account() { return account; },
    isSignedIn: function () { return !!account; },
    signInSurfaceActive: signInSurfaceActive,
    openSignIn: openSignIn, requireSignIn: requireSignIn, openAccount: openAccount,
    onChange: function (fn) { listeners.push(fn); try { fn(account); } catch (e) {} },
    updateFavorites: function (a) { if (account) account.favorites = a; },
    refresh: loadMe,
  };

  function init() { renderNav(); loadMe(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
