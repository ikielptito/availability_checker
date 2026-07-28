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
