// Shared front-end helpers — the single source of truth for HTML escaping.
// Load in <head> (after brand.css) so page inline scripts can call these:
//   <script src="/shared.js"></script>
// Pages must NOT re-declare esc/escapeHtml — a page-level function declaration
// would silently shadow these and reintroduce per-page drift.
window.esc = function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
};
window.escapeHtml = window.esc;

// Monthly/yearly rent → display string. Prices are stored in millions with a
// "jt" suffix ("30jt"), but the admin field is free text and villa-bula was
// saved as a bare "30". The old per-page formatters only handled the suffixed
// form and passed anything else through, so that listing rendered as
// "IDR 30 / mo" — thirty rupiah — on the shortlist page agents send clients.
// A bare number means millions here too; a full rupiah figure is scaled down.
// Non-numeric text ("negotiable", "on request") passes through untouched.
window.sbFmtPrice = function sbFmtPrice(p) {
  if (!p) return '';
  var s = String(p).trim();
  var m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:jt|juta)/i);
  if (m) return 'IDR ' + m[1].replace(',', '.') + 'M';
  var bare = s.match(/^(?:idr|rp)?\s*(\d+(?:[.,]\d+)?)$/i);
  if (bare) {
    var n = parseFloat(bare[1].replace(',', '.'));
    return 'IDR ' + (n >= 1e6 ? n / 1e6 : n) + 'M';
  }
  return s;
};

// Copy to clipboard, honestly. Resolves true on success, false on failure —
// never rejects, so a caller can always tell the user what happened.
//
// Two things went wrong with the old `navigator.clipboard.writeText(x).then(ok)`
// call sites: there was no .catch(), so a refused write rejected into the void
// and an agent who pressed "Share with client" saw nothing at all and assumed
// it had worked; and there was no fallback, so any context where the async
// clipboard is unavailable (older Safari, an insecure origin, a denied
// permission) simply could not copy. The execCommand path still works in most
// of those, so it is tried before giving up.
window.sbCopy = async function sbCopy(text) {
  const s = String(text == null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    // Off-screen but still selectable; position:fixed avoids scrolling the page.
    ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, s.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
};
