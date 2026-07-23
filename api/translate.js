// api/translate.js — batched EN→ID translation with a permanent per-string KV cache.
//
// POST { texts: string[], target: 'id' }  ->  { translations: string[] }
//
// Only cache-misses hit Anthropic (Haiku), batched into as few calls as possible.
// Every translated string is written back to Upstash under i18n:<target>:<sha1>,
// so the whole site's finite UI + finite set of listings is paid for essentially
// once. English is the source language; target 'en' is a no-op passthrough.

import crypto from 'crypto';

const SUPPORTED = new Set(['id']);
const MODEL = 'claude-haiku-4-5-20251001';
const BRAND_RE = /^(samba|samba rentals)$/i;

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function translatable(s) {
  const t = (s == null ? '' : String(s)).trim();
  if (t.length < 2) return false;      // single chars / empty
  if (!/[A-Za-z]/.test(t)) return false; // no Latin letters -> numbers, symbols, prices
  if (BRAND_RE.test(t)) return false;   // never translate the brand
  return true;
}

export default async function handler(req, res) {
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

  // ---- KV helpers (Upstash REST pipeline) ----
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
    // 1. Dedup the translatable strings.
    const uniq = [...new Set(texts.filter(translatable).map((s) => s.trim()))];

    // 2. Look them all up in one round-trip.
    const cache = new Map();
    if (uniq.length) {
      const cached = await kvMget(uniq.map((t) => `i18n:${target}:${sha1(t)}`));
      uniq.forEach((t, i) => { if (cached[i] != null) cache.set(t, cached[i]); });
    }

    // 3. Translate whatever is left, then persist it.
    const missing = uniq.filter((t) => !cache.has(t));
    if (missing.length) {
      const translated = await translateAll(missing, anthropicKey);
      const pairs = [];
      missing.forEach((t, i) => {
        const v = translated[i] != null ? translated[i] : t;
        cache.set(t, v);
        pairs.push([`i18n:${target}:${sha1(t)}`, v]);
      });
      await kvSetMany(pairs);
    }

    // 4. Map back onto the original array (untranslatable strings pass through).
    const translations = texts.map((orig) =>
      translatable(orig) ? (cache.get(orig.trim()) ?? orig) : orig
    );
    return res.status(200).json({ translations });
  } catch (e) {
    // Fail open: return the originals so the page stays usable in English.
    return res.status(200).json({ translations: texts, error: String(e && e.message || e) });
  }
}

// Translate an array of strings, chunked to keep each Anthropic response small.
async function translateAll(items, key) {
  const CHUNK = 50;
  const out = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    let arr;
    try { arr = await callAnthropic(slice, key); } catch { arr = null; }
    for (let j = 0; j < slice.length; j++) {
      out.push(arr && arr[j] != null ? String(arr[j]) : slice[j]);
    }
  }
  return out;
}

const SYSTEM = `You are a professional translator localizing a Balinese villa-rental website from English into Indonesian (Bahasa Indonesia). Translate each string naturally and concisely, in the register of a modern travel/booking app.

Rules:
- Keep the brand names "Samba" and "Samba Rentals" exactly as written.
- Keep numbers, prices, currency codes/symbols (USD, IDR, Rp, $), dates, times, URLs, emails, @handles and #hashtags unchanged.
- Do NOT translate proper nouns: villa names, place names (Bali, Canggu, Batu Bolong, Seminyak, etc.), or people's names.
- Preserve any {placeholder} or %s style tokens exactly.
- Keep it short — UI labels must stay compact.
- Return ONLY a JSON array of translated strings: same length, same order as the input. No commentary, no code fences.`;

async function callAnthropic(items, key) {
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
      messages: [{ role: 'user', content: `Translate these ${items.length} strings to Indonesian. Input JSON array:\n${JSON.stringify(items)}` }],
    }),
  });
  if (!resp.ok) throw new Error('anthropic ' + resp.status);
  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('');
  const arr = parseJsonArray(text);
  return Array.isArray(arr) ? arr : null;
}

function parseJsonArray(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}
