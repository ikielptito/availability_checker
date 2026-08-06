/*
 * back.js — site-wide "← back" chip for drill-in pages (listings, agent
 * profiles, reports, analytics, legal). Mounts into the page's own header,
 * or floats top-left when the page has none.
 *
 * Deliberately invisible to people who LAND here from outside (WhatsApp,
 * email, ads): it renders only when the visitor arrived from another Samba
 * page (same-origin referrer) or has in-tab history to pop. Shared listing
 * and report links therefore stay clean client-facing documents — the same
 * concern that removed listing.html's old hard-coded back-link.
 *
 * Usage: <script src="/back.js" defer data-fallback="/portal"></script>
 * data-fallback: destination when the tab has no history to pop (page was
 * opened in a new tab from inside Samba). Defaults to "/".
 */
(function () {
  if (window.SambaBack) return; window.SambaBack = true;
  var scr = document.currentScript;
  var fallback = (scr && scr.getAttribute('data-fallback')) || '/';

  function sameOriginRef() {
    try { return !!document.referrer && new URL(document.referrer).origin === location.origin; }
    catch (e) { return false; }
  }

  function boot() {
    // Same-origin referrer is the ONLY show signal. history.length is useless
    // for this: fresh tabs (WhatsApp in-app browser, our preview pane) open
    // with a blank entry already in history, so length > 1 would surface the
    // chip on externally shared listing/report links — exactly the audience
    // that must see a clean page. history is still consulted on click.
    if (!sameOriginRef()) return;

    var style = document.createElement('style');
    style.textContent =
      '#samba-back{flex-shrink:0;width:36px;height:36px;margin-right:2px;display:inline-flex;align-items:center;justify-content:center;' +
      'border-radius:50%;border:1px solid rgba(28,25,23,.14);background:rgba(255,255,255,.85);color:#1F2422;cursor:pointer;padding:0;transition:background .15s}' +
      '#samba-back:hover{background:#fff}' +
      '#samba-back.floating{position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);left:12px;z-index:950;box-shadow:0 2px 8px rgba(28,25,23,.14)}' +
      '@media print{#samba-back{display:none}}';
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.id = 'samba-back';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Back');
    btn.setAttribute('data-no-i18n', '');
    btn.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    btn.addEventListener('click', function () {
      if (history.length > 1) history.back();
      else location.href = fallback;
    });

    var host = document.querySelector('.topbar, .lp-nav, .legal-topbar, .nav, nav, header');
    if (host) host.insertBefore(btn, host.firstChild);
    else { btn.className = 'floating'; document.body.appendChild(btn); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
