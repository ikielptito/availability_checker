// lib/translate.js — batched EN→ID translation with a permanent per-string KV
// cache. Lives in lib/ (not api/) so it doesn't count against the serverless
// function limit; api/track.js delegates here when called as ?action=translate.
//
// runTranslate handles:  POST { texts: string[], target: 'id' }  ->  { translations }
//
// Only cache-misses hit Anthropic (Haiku), batched into as few calls as possible.
// Every translated string is written back under i18n:<target>:<sha1>, so the
// site's finite UI + finite set of listings is paid for essentially once.
// English is the source; target 'en' is a no-op passthrough.

import crypto from 'crypto';

const SUPPORTED = new Set(['id']);
const MODEL = 'claude-haiku-4-5-20251001';
const BRAND_RE = /^(samba|samba rentals)$/i;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function translatable(s) {
  const t = (s == null ? '' : String(s)).trim();
  if (t.length < 2) return false;
  if (!/[A-Za-z]/.test(t)) return false; // numbers / symbols / prices only
  if (BRAND_RE.test(t)) return false;
  return true;
}

export async function runTranslate(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Translation not configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const target = String(body?.target || 'id').toLowerCase();
  const texts = Array.isArray(body?.texts) ? body.texts.map((t) => (t == null ? '' : String(t))) : [];

  if (target === 'en') return res.status(200).json({ translations: texts });
  if (!SUPPORTED.has(target)) return res.status(400).json({ error: 'Unsupported target' });
  if (!texts.length) return res.status(200).json({ translations: [] });
  if (texts.length > 300) return res.status(400).json({ error: 'Too many texts (max 300)' });

  async function kvMget(keys) {
    if (!kvUrl || !kvToken || !keys.length) return keys.map(() => null);
    try {
      const r = await fetch(`${kvUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(keys.map((k) => ['GET', k])),
      });
      const j = await r.json();
      return (Array.isArray(j) ? j : []).map((x) => {
        const v = x && x.result;
        if (v == null) return null;
        try { return JSON.parse(v); } catch { return null; }
      });
    } catch { return keys.map(() => null); }
  }
  async function kvSetMany(pairs) {
    if (!kvUrl || !kvToken || !pairs.length) return;
    try {
      await fetch(`${kvUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(pairs.map(([k, v]) => ['SET', k, JSON.stringify(v)])),
      });
    } catch { /* best-effort cache write */ }
  }

  try {
    const uniq = [...new Set(texts.filter(translatable).map((s) => s.trim()))];

    const cache = new Map();
    if (uniq.length) {
      const cached = await kvMget(uniq.map((t) => `i18n:${target}:${sha1(t)}`));
      uniq.forEach((t, i) => { if (cached[i] != null) cache.set(t, cached[i]); });
    }

    const missing = uniq.filter((t) => !cache.has(t));
    if (missing.length) {
      const translated = await translateAll(missing, anthropicKey);
      const pairs = [];
      missing.forEach((t, i) => {
        const v = translated[i];
        // Only cache real translations. A miss (null) is left uncached so the
        // string stays English in the output AND a later request retries it —
        // never poison the permanent cache with the original or a stale value.
        if (v != null && v !== '' && v !== t) {
          cache.set(t, v);
          pairs.push([`i18n:${target}:${sha1(t)}`, v]);
        }
      });
      await kvSetMany(pairs);
    }

    const translations = texts.map((orig) =>
      translatable(orig) ? (cache.get(orig.trim()) ?? orig) : orig
    );
    return res.status(200).json({ translations });
  } catch (e) {
    // Fail open: return originals so the page stays usable in English.
    return res.status(200).json({ translations: texts, error: String(e && e.message || e) });
  }
}

// Returns an array aligned 1:1 with `items`; each slot is the translation or
// null on a miss. Never returns a shifted/misaligned result: each string is
// tagged with an explicit index and results are mapped back by that index, so a
// dropped or merged item can only null-out itself, never poison its neighbours.
async function translateAll(items, key) {
  const CHUNK = 40;
  const out = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    let map;
    try { map = await callAnthropic(slice, key); } catch { map = null; }
    if (map) for (let j = 0; j < slice.length; j++) {
      if (map.has(j)) out[i + j] = map.get(j);
    }
  }
  return out;
}

const SYSTEM = `You are a professional translator localizing a Balinese villa-rental website from English into Indonesian (Bahasa Indonesia). Translate naturally and concisely, in the register of a modern travel/booking app.

Rules:
- Keep the brand names "Samba" and "Samba Rentals" exactly as written.
- Keep numbers, prices, currency codes/symbols (USD, IDR, Rp, $), dates, times, URLs, emails, @handles and #hashtags unchanged.
- Do NOT translate proper nouns: villa names, place names (Bali, Canggu, Batu Bolong, Seminyak, etc.), or people's names.
- Preserve any {placeholder} or %s style tokens exactly.
- Keep it short — UI labels must stay compact.`;

// Each item is sent as {"i": index, "t": text}; the model must echo the same
// index with its translation. We map by index, so alignment can never drift.
async function callAnthropic(items, key) {
  const numbered = items.map((t, i) => ({ i, t }));
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: 'user', content:
        'Translate the "t" value of each object below to Indonesian. Return ONLY a JSON array ' +
        'of objects {"i": <the same index>, "t": "<translation>"} — one per input object, ' +
        'echoing every "i" exactly. No commentary, no code fences.\n' + JSON.stringify(numbered) }],
    }),
  });
  if (!resp.ok) throw new Error('anthropic ' + resp.status);
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const arr = parseJsonArray(text);
  if (!Array.isArray(arr)) return null;
  const map = new Map();
  for (const o of arr) {
    if (o && Number.isInteger(o.i) && typeof o.t === 'string' && o.t !== '') map.set(o.i, o.t);
  }
  return map;
}

function parseJsonArray(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}
