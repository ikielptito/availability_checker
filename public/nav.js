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
  .snav-subtabs{display:inline-flex;align-items:center;gap:2px;flex-shrink:0}
  .snav-stab{display:inline-flex;align-items:center;gap:6px;border:none;background:none;font-family:'Geist',-apple-system,sans-serif;font-size:.78rem;font-weight:500;letter-spacing:.01em;color:#6b6557;padding:8px 12px;border-radius:999px;text-decoration:none;cursor:pointer;white-space:nowrap;transition:background .18s cubic-bezier(.2,.8,.2,1),color .18s cubic-bezier(.2,.8,.2,1)}
  .snav-stab:hover{background:#F5F1EB;color:#1C1917}
  .snav-stab.on{color:#C46E4B;background:#F6E7DE}
  .snav-stab svg{width:16px;height:16px;flex-shrink:0}
  .snav-stab .snav-av{width:22px;height:22px}
  /* Tier 1 — floating glass portal bar. Always visible, every viewport: the
     one site-wide gesture for switching between the two portals. Matches the
     static .lp-switch pill on the marketing/legal pages. */
  /* translateZ(0) + backface-visibility pin the bar to its own compositor layer
     so iOS Safari keeps it locked to the viewport during momentum scroll
     (fixed + backdrop-filter otherwise lags upward and snaps back). */
  #snav-tabs{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom));z-index:900;display:flex;width:min(440px,calc(100% - 24px));background:rgba(255,255,255,.93);backdrop-filter:blur(28px);-webkit-backdrop-filter:blur(28px);border:1px solid rgba(28,25,23,.09);border-radius:999px;padding:5px;box-sizing:border-box;box-shadow:0 1px 2px rgba(28,25,23,.06),0 8px 22px rgba(28,25,23,.1);transform:translateX(-50%) translateZ(0);-webkit-transform:translateX(-50%) translateZ(0);backface-visibility:hidden;-webkit-backface-visibility:hidden}
  #snav-tabs .snav-ptab{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;font-family:'Geist',-apple-system,sans-serif;font-size:.9rem;font-weight:600;letter-spacing:.01em;color:#8a8478;text-decoration:none;padding:13px 10px;border-radius:999px;transition:background .18s cubic-bezier(.2,.8,.2,1),color .18s cubic-bezier(.2,.8,.2,1)}
  #snav-tabs .snav-ptab:not(.on):hover{background:#F5F1EB}
  #snav-tabs .snav-ptab.on{color:#B23E19;background:#FBEDE7}
  #snav-tabs .snav-ptab svg{width:18px;height:18px;flex-shrink:0}
  body{padding-bottom:calc(90px + env(safe-area-inset-bottom))}
  @media(max-width:760px){
    #snav-sub{padding:8px 16px 0;gap:8px}
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
  .snav-benefits{list-style:none;margin:2px 0;padding:0;display:flex;flex-direction:column;gap:9px}
  .snav-benefits li{display:flex;gap:9px;align-items:flex-start;font-size:.84rem;line-height:1.5;color:var(--sb-text-2,#514C45)}
  .snav-benefits li b{color:var(--sb-text,#1C1917);font-weight:650}
  /* Quiet terracotta ticks, not filled chips: the product mockup carries the visual weight now */
  .snav-benefits .snav-bcheck{flex-shrink:0;width:16px;height:16px;color:var(--sb-terracotta,#C46E4B);margin-top:1px}
  .snav-gbtn{display:flex;justify-content:center;min-height:44px}
  .snav-guest{display:block;width:100%;text-align:center;background:none;border:none;color:#8a8478;font-family:'Geist',-apple-system,sans-serif;font-size:.8rem;font-weight:500;cursor:pointer;padding:8px 4px;transition:color .18s ease;text-decoration:none;box-sizing:border-box}
  .snav-guest:hover{color:#514C45}
  /* Sign-in modal — product-led split: villa-share mockup beside the welcome.
     The mockup does the selling, so the copy side stays quiet and typographic. */
  .snav-si-box{position:relative;max-width:720px;display:grid;grid-template-columns:minmax(0,43%) 1fr;overflow:hidden}
  /* Image is absolutely filled so the copy panel dictates the modal height
     (the mockup is very tall; left to flow it would stretch the whole sheet). */
  .snav-si-media{position:relative;background:var(--sb-terracotta-050,#FBEDE7);overflow:hidden}
  .snav-si-media img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center;display:block}
  /* Soft inner edge so the mockup melts into the copy panel instead of a hard seam */
  .snav-si-media::after{content:"";position:absolute;inset:0;box-shadow:inset -22px 0 26px -22px rgba(28,25,23,.14);pointer-events:none}
  .snav-si-panel{display:flex;flex-direction:column;min-width:0}
  .snav-x-float{position:absolute;top:14px;right:14px;width:32px;height:32px;border-radius:50%;background:#F5F1EB;border:none;color:#8a8478;font-size:1.25rem;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;z-index:2;transition:color .18s ease,background .18s ease}
  .snav-x-float:hover{color:#1C1917;background:#F1ECE7}
  .snav-si-hero{padding:34px 30px 0;display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:11px}
  .snav-si-logo{display:block;height:46px;width:auto}
  .snav-si-title{font-family:var(--sb-font-display,'Satoshi'),'Geist',-apple-system,sans-serif;font-weight:700;font-size:1.5rem;line-height:1.12;color:var(--sb-text,#1C1917);letter-spacing:-.02em}
  .snav-si-lede{color:var(--sb-muted,#8a8478);font-size:.86rem;line-height:1.55;margin:-3px 0 0;max-width:330px}
  .snav-si-box .snav-box-body{padding:16px 30px 26px;gap:13px}
  @media(max-width:640px){
    /* Stack: the mockup becomes a top band cropped to the villa card, CTA stays reachable */
    .snav-si-box{grid-template-columns:1fr;max-width:420px}
    /* The 3:2 band matches the graphic's aspect ratio, so both devices sit fully
       in frame — never cover-cropped through the middle of a screen. */
    .snav-si-media{height:auto;aspect-ratio:3/2}
    .snav-si-media img{object-position:center}
    .snav-si-media::after{box-shadow:inset 0 -20px 24px -20px rgba(28,25,23,.14)}
    .snav-si-hero{align-items:center;text-align:center;padding:24px 24px 0}
    .snav-si-box .snav-box-body{padding:14px 24px 22px}
  }
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
  /* Google-look button for the webview escape — same promise as the real GSI
     pill, the browser hop is just plumbing */
  .snav-gsi-like{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;box-sizing:border-box;background:#fff;border:1px solid #dadce0;border-radius:999px;padding:12px 18px;font-family:'Geist',-apple-system,sans-serif;font-size:.88rem;font-weight:500;color:#3c4043;cursor:pointer;transition:background .18s ease,box-shadow .18s ease}
  .snav-gsi-like:hover{background:#f8f9fa;box-shadow:0 1px 3px rgba(60,64,67,.15)}
  .snav-gsi-like svg{width:18px;height:18px;flex-shrink:0}
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
    house: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    check: '<svg class="snav-bcheck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function initials(n) { return (n || 'A').trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }

  // ── Portal + sub-tab model ──
  var PORTALS = [
    { key: 'agent', label: 'Agent portal', href: '/', icon: I.person },
    { key: 'owner', label: 'Owner portal', href: '/portal', icon: I.house },
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
  // innerWidth reads 0 in hidden/background contexts (prerender, hidden
  // webview panes) — fall back to screen width so the mount choice stays sane.
  function viewportW() { return window.innerWidth || (window.screen && screen.width) || 1024; }

  function renderNav() {
    var portal = curPortal(), sub = curSub();
    // Tier 1 — bottom portal bar (mobile)
    var bottom = document.getElementById('snav-tabs');
    if (!bottom) { bottom = document.createElement('div'); bottom.id = 'snav-tabs'; document.body.appendChild(bottom); }
    bottom.innerHTML = PORTALS.map(function (p) {
      // Signed-out owners hopping to the agent portal get the owner-preview
      // banner (?from=owner) so there's always a way back to the listing flow.
      var href = (p.key === 'agent' && portal === 'owner' && !account) ? '/?from=owner' : p.href;
      return '<a class="snav-ptab' + (p.key === portal ? ' on' : '') + '" href="' + href + '">' + p.icon + '<span>' + esc(p.label) + '</span></a>';
    }).join('');
    // Tier 2 — sub-tab strip. Preferred mount is INSIDE the topbar row (via
    // the #samba-nav slot) so the logo and tabs share one line — but only when
    // the row has room. On phones the topbar (logo, help, language toggle)
    // leaves too little width, and the flex-end + overflow combination clipped
    // the leading tab to a half-visible sliver — so ≤640px the strip mounts as
    // its own full-width row below the topbar instead (labels included).
    var strip = document.getElementById('snav-sub');
    var host = document.getElementById('samba-nav');
    var wantInline = !!host && viewportW() > 640;
    if (strip && strip.classList.contains('inline') !== wantInline) { strip.remove(); strip = null; }
    if (!strip) {
      strip = document.createElement('div'); strip.id = 'snav-sub';
      var tb = document.querySelector('.topbar');
      if (wantInline) { strip.className = 'inline'; host.appendChild(strip); }
      else if (tb && tb.parentNode) tb.parentNode.insertBefore(strip, tb.nextSibling);
      else document.body.insertBefore(strip, document.body.firstChild);
    }
    // No desktop segmented portal control — the always-visible bottom pill is
    // the single portal-switching gesture at every width.
    var tabs = '<div class="snav-subtabs">' + subTabs().map(function (t) {
      var inner = t.icon + '<span>' + esc(t.label) + '</span>';
      var on = t.key === sub ? ' on' : '';
      return t.act ? '<button class="snav-stab' + on + '" data-act="' + t.act + '">' + inner + '</button>'
                   : '<a class="snav-stab' + on + '" href="' + t.href + '">' + inner + '</a>';
    }).join('') + '</div>';
    strip.innerHTML = tabs;
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
  // engagement-cadence prompt take over. The owner portal has its own flow (the
  // /home intro page owns sign-in), so it is left to One Tap here. Returns true
  // when it claims this page load (so One Tap stays quiet).
  function maybeLandingPrompt() {
    if (curPortal() !== 'agent') return false;   // owner portal: /home + demo handle sign-in
    // In-app browsers (most WhatsApp arrivals) get the sheet too — its CTA
    // there is the browser-escape hop rather than the Google button.
    try {
      if (sessionStorage.getItem('samba_landing_prompted')) return false;
      sessionStorage.setItem('samba_landing_prompted', '1');
      sessionStorage.setItem('samba_sp_sess', '1');  // villa-close prompt stays quiet this session
    } catch (e) { return false; }
    setTimeout(function () {
      // Don't stack on the agent portal's first-run welcome card. That card
      // opens at 700ms and this at 1400ms, so a brand-new agent got two
      // full-screen sheets at once, both headed "Welcome to Samba". Once the
      // welcome has been dismissed the flag is set and this prompt resumes.
      var greeted = true;
      try { greeted = !!localStorage.getItem('samba_agent_welcome_v1'); } catch (e) {}
      if (greeted && !account) openSignIn('landing');
    }, 1400);
    return true;
  }

  function loadGsi(cb) {
    if (window.google && google.accounts && google.accounts.id) return cb();
    var s = document.getElementById('snav-gsi');
    if (!s) { s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.id = 'snav-gsi'; document.head.appendChild(s); }
    var t = setInterval(function () { if (window.google && google.accounts && google.accounts.id) { clearInterval(t); cb(); } }, 100);
  }
  // Contextual headlines: the gate that opened the modal names the value the
  // user was reaching for, instead of a generic welcome pitch. The 'owner'
  // entry is the owner portal's default (its sheet is the auth gate over the
  // demo dashboard — the pitch itself lives on /home).
  var SIGNIN_COPY = {
    favorite:  { title: 'Save this villa',          lede: 'Sign in to keep favourites and private notes on every device.' },
    shortlist: { title: 'Build a client shortlist', lede: 'Sign in to pick villas and send your client one polished link.' },
    story:     { title: 'Make this story yours',    lede: 'Sign in and this Instagram story carries YOUR name, photo and WhatsApp — clients contact you, not us.' },
    owner:     { title: 'Your owner portal',        lede: 'Sign in to list your villa and manage availability, photos and pricing. New here? Google sign-in creates your account.' },
    'default': { title: 'Welcome to Samba',         lede: 'One account for favourites, shortlists and your public agent profile.' }
  };
  function ensureSignIn() {
    var ov = document.getElementById('snav-signin'); if (ov) return ov;
    var owner = curPortal() === 'owner';
    var benefits = owner
      ? '<li>' + I.check + '<span><b>One listing, 300+ rental agents.</b> Every agent on Samba sees your live availability</span></li>' +
        '<li>' + I.check + '<span><b>Weekly reports on WhatsApp.</b> Views, shares and client enquiries for your villa</span></li>'
      : '<li>' + I.check + '<span><b>Clients enquire with you.</b> Your name, photo and WhatsApp on every villa you share</span></li>' +
        '<li>' + I.check + '<span><b>Favourites &amp; shortlists,</b> synced and ready to send as one link</span></li>';
    ov = document.createElement('div'); ov.className = 'snav-ov'; ov.id = 'snav-signin';
    ov.innerHTML = '<div class="snav-box snav-si-box"><button class="snav-x-float" data-close aria-label="Close">&times;</button>' +
      // Stacked (mobile) layout uses a purpose-made 3:2 laptop+phone graphic in a
      // matching 3:2 band, so the devices are never cover-cropped. The side-by-side
      // (desktop) layout keeps the tall hand-held phone photo that fits its column.
      '<div class="snav-si-media"><picture>' +
      '<source media="(max-width:640px)" srcset="/img-signin-devices.webp">' +
      '<img id="snav-si-shot" src="/img-hero-phone.webp" alt=""></picture></div>' +
      '<div class="snav-si-panel">' +
      // Both sheets show the full Samba lockup, not the square app icon.
      '<div class="snav-si-hero">' +
      '<img class="snav-si-logo" src="/logo-samba.png" alt="Samba — connecting owners & agents">' +
      '<div class="snav-si-title" id="snav-si-title">Welcome to Samba</div>' +
      '<p class="snav-si-lede" id="snav-si-lede">One account for favourites, shortlists and your public agent profile.</p></div>' +
      '<div class="snav-box-body">' +
      '<ul class="snav-benefits">' + benefits + '</ul>' +
      '<div class="snav-gbtn" id="snav-gbtn"></div>' +
      '<div class="snav-wait" id="snav-signin-wait" style="display:none"><span class="snav-spin"></span> Signing you in…</div>' +
      '<div class="snav-err" id="snav-signin-err"></div>' +
      (owner
        ? '<div class="snav-fineprint">The first 25 villas list free with code FOUNDING25</div>' +
          '<button class="snav-guest" data-close>Explore the demo first</button>' +
          '<a class="snav-guest" href="/home">New to Samba? See how it works &rarr;</a>'
        : '<div class="snav-fineprint">Free for agents · no card required</div>' +
          '<button class="snav-guest" data-close>Continue as guest</button>') +
      '</div></div></div>';
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
    var copy = SIGNIN_COPY[ctx] || SIGNIN_COPY[curPortal() === 'owner' ? 'owner' : 'default'];
    document.getElementById('snav-si-title').textContent = copy.title;
    document.getElementById('snav-si-lede').textContent = copy.lede;
    var slot = document.getElementById('snav-gbtn'); slot.innerHTML = ''; slot.style.display = '';
    document.getElementById('snav-signin-wait').style.display = 'none';
    document.getElementById('snav-signin-err').textContent = '';
    snTrack('signup_shown_' + sigSource);
    // Owner sheet: swap the static founding fineprint for the live count.
    if (curPortal() === 'owner') {
      fetch('/api/home-stats').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        var f = d && d.founding;
        var els = ov.querySelectorAll('.snav-fineprint');
        if (!f || typeof f.remaining !== 'number' || !els.length) return;
        var el = els[els.length - 1];
        if (f.remaining > 0 && f.active) {
          if (f.used > 0) el.textContent = f.remaining + ' of the 25 free founding spots left — code FOUNDING25';
        } else {
          el.textContent = 'IDR 150,000/month per villa · no commissions, no booking fees';
        }
      }).catch(function () {});
    }
    if (isInAppBrowser()) {
      // Google blocks OAuth inside embedded webviews (403 disallowed_useragent),
      // so the primary CTA hops to the real browser, which reopens this sheet
      // on arrival (?signin=1 → maybeHandoff). Manual instructions only appear
      // if the hop is blocked.
      var gLogo = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
      slot.innerHTML = '<div class="snav-handoff">' +
        '<button class="snav-gsi-like" id="snav-inapp-open">' + gLogo + 'Continue with Google</button>' +
        '<div class="snav-fineprint">Opens in your phone\'s browser. You\'ll land right back here.</div>' +
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
        // WhatsApp-required onboarding for new/incomplete agents — agent portal
        // only: owners signing in on /portal go straight to their dashboard.
        if (curPortal() === 'agent' && !(account.profile && account.profile.waNumber)) { hideToast(); openAccount(true); }
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
  // The story gate gets its own tracking suffix (signup_shown_story /
  // signup_done_story) — it's the highest-intent surface and worth measuring
  // apart from the generic gate.
  function requireSignIn(fn, ctx) { if (account) { fn(); return; } pendingAfterSignIn = fn; openSignIn(ctx === 'story' ? 'story' : 'gate', ctx); }

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
          '<div class="snav-welcome-sub">You\'re in: this is your agent card. Add your WhatsApp number so clients can reach you about villas you share.</div></div>'
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
      '<div class="snav-sub-card"><div class="snav-sub-row"><span class="snav-sub-plan">Listing subscription</span><span class="snav-sub-status">' + esc(statusLabel) + '</span></div><div class="snav-sub-price">IDR 150k <span>/ month per villa</span></div><div class="snav-sub-note">Your villas stay live to 300+ Bali rental agents while your subscription is active. Cancel anytime.</div></div>' +
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

  function init() {
    renderNav(); loadMe();
    // Re-mount the sub-tab strip when the viewport crosses the inline/below
    // breakpoint (rotation, window resize).
    var rzTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        var strip = document.getElementById('snav-sub');
        var wantInline = !!document.getElementById('samba-nav') && viewportW() > 640;
        if (strip && strip.classList.contains('inline') !== wantInline) renderNav();
      }, 150);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
