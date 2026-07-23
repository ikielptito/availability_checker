/*
 * i18n.js — bilingual EN/ID for Samba Rentals.
 *
 * One mechanism covers all three content types:
 *   1. static HTML copy         — translated on first paint
 *   2. JS-rendered UI strings   — caught by the MutationObserver as they mount
 *   3. dynamic listing content  — caught by the same observer when it arrives
 *
 * English is the source. When the user picks ID, every translatable text node
 * and attribute (placeholder/title/aria-label/alt, submit-button values) is sent
 * to /api/translate, which caches each string permanently in Redis. Results are
 * also cached in localStorage, so repeat visits swap with no visible flash.
 *
 * Opt-out of a subtree with  data-no-i18n.
 */
(function () {
  if (window.SambaI18n) return;

  var LANG_KEY = 'samba_lang';
  var CACHE_PREFIX = 'samba_i18n_';           // + lang  ->  { originalEN: translated }
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, CODE: 1, PRE: 1, TEXTAREA: 1, KBD: 1, SAMP: 1 };
  var BRAND_RE = /^(samba|samba rentals)$/i;

  var lang = 'en';
  try { lang = localStorage.getItem(LANG_KEY) || 'en'; } catch (e) {}
  if (lang !== 'id') lang = 'en';

  var cache = loadCache(lang);                 // originalEN -> translated (current lang)
  var tracked = [];                            // captured targets: {node, kind, attr}
  var seenText = new WeakSet();                // text nodes already tracked
  var orig = new WeakMap();                    // node -> { text, placeholder, ... , value }
  var observer = null;
  var flushTimer = null;
  var pendingCores = new Set();                // English cores awaiting a network fetch

  document.documentElement.lang = lang;

  // ---------- helpers ----------
  function loadCache(l) {
    try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + l) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_PREFIX + lang, JSON.stringify(cache)); } catch (e) {}
  }
  function translatable(s) {
    if (!s) return false;
    var t = s.trim();
    if (t.length < 2) return false;
    if (!/[A-Za-z]/.test(t)) return false;     // numbers / prices / symbols only
    if (BRAND_RE.test(t)) return false;
    return true;
  }
  // split "  Core text  " -> ["  ", "Core text", "  "] so surrounding whitespace survives
  function splitWs(v) {
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(v);
    return m ? [m[1], m[2], m[3]] : ['', v, ''];
  }
  function getOrig(node) {
    var o = orig.get(node);
    if (!o) { o = {}; orig.set(node, o); }
    return o;
  }

  // ---------- collect translatable targets under a root ----------
  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) { trackText(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP_TAGS[root.tagName] || root.closest('[data-no-i18n]')) return;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (SKIP_TAGS[n.tagName] || n.hasAttribute('data-no-i18n')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    // include the root element itself for attribute capture
    if (root.nodeType === 1) trackAttrs(root);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) trackText(n);
      else trackAttrs(n);
    }
  }

  function trackText(node) {
    if (seenText.has(node)) return;
    if (!node.parentNode) return;
    var parent = node.parentNode;
    if (parent.nodeType === 1 && (SKIP_TAGS[parent.tagName] || parent.closest('[data-no-i18n]'))) return;
    var core = splitWs(node.nodeValue)[1];
    if (!translatable(core)) return;
    seenText.add(node);
    getOrig(node).text = node.nodeValue;       // captured while still English
    tracked.push({ node: node, kind: 'text' });
    need(core);
  }

  function trackAttrs(el) {
    var o = getOrig(el);
    ATTRS.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      if (o[a] !== undefined) return;
      var v = el.getAttribute(a);
      if (!translatable(v)) return;
      o[a] = v;
      tracked.push({ node: el, kind: 'attr', attr: a });
      need(splitWs(v)[1]);
    });
    if (el.tagName === 'INPUT') {
      var ty = (el.getAttribute('type') || '').toLowerCase();
      if ((ty === 'submit' || ty === 'button') && o.value === undefined && translatable(el.value)) {
        o.value = el.value;
        tracked.push({ node: el, kind: 'value' });
        need(splitWs(el.value)[1]);
      }
    }
  }

  function need(core) {
    if (lang !== 'id') return;
    if (cache[core] === undefined) pendingCores.add(core);
  }

  function coreOf(item) {
    var o = orig.get(item.node);
    if (!o) return '';
    if (item.kind === 'text') return splitWs(o.text)[1];
    if (item.kind === 'attr') return splitWs(o[item.attr])[1];
    return splitWs(o.value)[1];
  }

  // Queue every already-tracked string that isn't cached yet (used on EN->ID,
  // where scan() skips nodes it captured while the page was still English).
  function queueAll() {
    if (lang !== 'id') return;
    for (var i = 0; i < tracked.length; i++) {
      if (!tracked[i].node.isConnected) continue;
      var core = coreOf(tracked[i]);
      if (core && cache[core] === undefined) pendingCores.add(core);
    }
  }

  // ---------- apply / restore ----------
  function render(item) {
    var o = orig.get(item.node);
    if (!o) return;
    if (item.kind === 'text') {
      var parts = splitWs(o.text);
      var core = parts[1];
      var val = (lang === 'id' && cache[core] != null) ? (parts[0] + cache[core] + parts[2]) : o.text;
      if (item.node.nodeValue !== val) item.node.nodeValue = val;
    } else if (item.kind === 'attr') {
      var op = splitWs(o[item.attr]);
      var av = (lang === 'id' && cache[op[1]] != null) ? (op[0] + cache[op[1]] + op[2]) : o[item.attr];
      if (item.node.getAttribute(item.attr) !== av) item.node.setAttribute(item.attr, av);
    } else if (item.kind === 'value') {
      var ov = splitWs(o.value);
      var vv = (lang === 'id' && cache[ov[1]] != null) ? (ov[0] + cache[ov[1]] + ov[2]) : o.value;
      if (item.node.value !== vv) item.node.value = vv;
    }
  }

  function renderAll() {
    if (observer) observer.disconnect();
    for (var i = tracked.length - 1; i >= 0; i--) {
      if (!tracked[i].node.isConnected) { tracked.splice(i, 1); continue; }
      render(tracked[i]);
    }
    observeStart();
  }

  // ---------- network ----------
  function flush() {
    flushTimer = null;
    if (lang !== 'id' || !pendingCores.size) return;
    var batch = Array.from(pendingCores);
    pendingCores.clear();
    setPill('busy');

    var CHUNK = 100, chunks = [];
    for (var i = 0; i < batch.length; i += CHUNK) chunks.push(batch.slice(i, i + CHUNK));

    Promise.all(chunks.map(function (texts) {
      return fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: texts, target: 'id' }),
      }).then(function (r) { return r.json(); }).then(function (data) {
        var tr = (data && data.translations) || [];
        texts.forEach(function (t, idx) { if (tr[idx] != null) cache[t] = tr[idx]; });
      }).catch(function () {});
    })).then(function () {
      saveCache();
      if (lang === 'id') renderAll();
      setPill('idle');
    });
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 120);
  }

  // ---------- observe dynamic content (scopes 2 & 3) ----------
  function observeStart() {
    if (!observer) {
      observer = new MutationObserver(function (muts) {
        var before = tracked.length;
        muts.forEach(function (m) {
          if (m.type === 'childList') {
            m.addedNodes.forEach(function (nd) { scan(nd); });
          } else if (m.type === 'characterData') {
            // text rewritten by the app: re-capture as new English source
            var nd = m.target;
            if (nd && nd.nodeType === 3 && !isOurWrite(nd)) { seenText.delete(nd); trackText(nd); }
          } else if (m.type === 'attributes') {
            if (m.target && m.target.nodeType === 1) trackAttrs(m.target);
          }
        });
        if (tracked.length !== before && lang === 'id') { renderAll(); scheduleFlush(); }
      });
    }
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
  }
  // characterData mutations we caused equal the cached translation -> ignore them
  function isOurWrite(node) {
    var o = orig.get(node);
    if (!o || o.text === undefined) return false;
    var core = splitWs(o.text)[1];
    return lang === 'id' && cache[core] != null && node.nodeValue.indexOf(cache[core]) !== -1;
  }

  // ---------- public: switch language ----------
  function setLang(next) {
    next = next === 'id' ? 'id' : 'en';
    if (next === lang) return;
    lang = next;
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) {}
    document.documentElement.lang = lang;
    cache = loadCache(lang);
    updatePill();
    // make sure everything on the page is captured, then apply
    scan(document.body);
    if (lang === 'id') { queueAll(); renderAll(); flush(); }  // fetch any missing immediately
    else { renderAll(); }                                     // restore English from originals
  }

  // ---------- toggle pill ----------
  var pill;
  function buildPill() {
    var style = document.createElement('style');
    style.textContent =
      '#samba-lang{position:fixed;top:calc(env(safe-area-inset-top,0px) + 12px);right:12px;z-index:960;' +
      'display:inline-flex;gap:2px;padding:3px;border-radius:999px;background:rgba(255,255,255,.92);' +
      'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid rgba(28,25,23,.10);' +
      'box-shadow:0 1px 2px rgba(28,25,23,.06),0 4px 14px rgba(28,25,23,.10);font-family:"Geist",-apple-system,BlinkMacSystemFont,sans-serif}' +
      '#samba-lang button{border:none;background:none;cursor:pointer;font:inherit;font-size:.72rem;font-weight:600;' +
      'letter-spacing:.03em;color:#8a8478;padding:5px 10px;border-radius:999px;line-height:1;transition:background .18s,color .18s}' +
      '#samba-lang button.on{background:#F6E7DE;color:#C46E4B}' +
      '#samba-lang.busy{opacity:.6;pointer-events:none}' +
      '@media print{#samba-lang{display:none}}';
    document.head.appendChild(style);

    pill = document.createElement('div');
    pill.id = 'samba-lang';
    pill.setAttribute('data-no-i18n', '');
    pill.setAttribute('role', 'group');
    pill.setAttribute('aria-label', 'Language');
    pill.innerHTML =
      '<button type="button" data-set="en">EN</button>' +
      '<button type="button" data-set="id">ID</button>';
    pill.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      setLang(b.getAttribute('data-set'));
    });
    document.body.appendChild(pill);
    updatePill();
  }
  function updatePill() {
    if (!pill) return;
    pill.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-set') === lang);
    });
  }
  function setPill(state) {
    if (!pill) return;
    pill.classList.toggle('busy', state === 'busy');
  }

  // ---------- boot ----------
  function boot() {
    buildPill();
    scan(document.body);
    observeStart();
    if (lang === 'id') { renderAll(); flush(); }   // cached strings apply instantly; misses fetch
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.SambaI18n = {
    get lang() { return lang; },
    setLang: setLang,
    retranslate: function () { scan(document.body); renderAll(); if (lang === 'id') scheduleFlush(); },
  };
})();
