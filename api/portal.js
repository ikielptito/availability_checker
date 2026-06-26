// Owner / property-manager portal API. Single function, routed by ?action=
// to stay under Vercel Hobby's function cap.
//
//   GET  ?action=config        → public config for the frontend (Google client id)
//   POST ?action=auth/google   → verify Google ID token, create session, set cookie
//   GET  ?action=auth/me       → current signed-in owner (from session cookie)
//   POST ?action=auth/logout   → destroy session, clear cookie
//
// No npm deps: Google token verification uses Google's tokeninfo endpoint,
// sessions are random tokens stored in KV with a TTL, cookies are httpOnly.
import crypto from 'node:crypto';

const SESSION_COOKIE = 'samba_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days

// Google OAuth Web client ID. Public by design (embedded in the frontend).
// Env var overrides the default so the dev harness can use a fake id.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  || '563689768498-6ihrl9icopscgneu6n133qns0hvhfn6m.apps.googleusercontent.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  // ── KV via Upstash REST command pipeline (works against the dev mock too) ──
  async function kvCmd(cmd) {
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([cmd]),
    });
    const out = await r.json();
    return Array.isArray(out) ? out[0]?.result : undefined;
  }
  async function kvPipeline(cmds) {
    const out = [];
    for (let i = 0; i < cmds.length; i += 400) {
      const r = await fetch(`${kvUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.slice(i, i + 400)),
      });
      const d = await r.json();
      if (!Array.isArray(d)) throw new Error('Pipeline failed');
      out.push(...d.map(x => x.result));
    }
    return out;
  }
  async function kvGet(key) {
    const raw = await kvCmd(['GET', key]);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  const kvSet = (key, value) => kvCmd(['SET', key, JSON.stringify(value)]);
  const kvSetEx = (key, value, ttl) => kvCmd(['SET', key, JSON.stringify(value), 'EX', String(ttl)]);
  const kvDel = (key) => kvCmd(['DEL', key]);

  const action = req.query.action || '';

  try {
    if (action === 'config' && req.method === 'GET') {
      return res.status(200).json({
        googleClientId: GOOGLE_CLIENT_ID,
        paddleClientToken: process.env.PADDLE_CLIENT_TOKEN || '',
        paddlePriceId: process.env.PADDLE_PRICE_ID || '',
        paddleEnv: process.env.PADDLE_ENV === 'production' ? 'production' : 'sandbox',
      });
    }
    if (action === 'auth/google' && req.method === 'POST') {
      return authGoogle(req, res, { kvGet, kvSet, kvSetEx });
    }
    if (action === 'auth/me' && req.method === 'GET') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return res.status(200).json({ owner: publicOwner(owner) });
    }
    if (action === 'auth/logout' && req.method === 'POST') {
      const token = readSessionToken(req);
      if (token) await kvDel(`session:${token}`);
      res.setHeader('Set-Cookie', clearCookie(isSecure(req)));
      return res.status(200).json({ ok: true });
    }

    // ── Owner property actions (session-gated) ──
    if (action === 'properties' && req.method === 'GET') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return listProperties(res, owner, { kvGet });
    }
    if (action === 'property' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return saveProperty(req, res, owner, { kvGet, kvSet });
    }
    if (action === 'property' && req.method === 'DELETE') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return deleteProperty(req, res, owner, { kvGet, kvSet, kvDel });
    }
    if (action === 'analytics' && req.method === 'GET') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return ownerAnalytics(req, res, owner, { kvGet, kvPipeline });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: e.message });
  }
}

// ── Google sign-in ──────────────────────────────────────────────────
async function authGoogle(req, res, { kvGet, kvSet, kvSetEx }) {
  const idToken = req.body?.credential || req.body?.id_token;
  if (!idToken) return res.status(400).json({ error: 'Missing credential' });

  // Verify the token with Google (no SDK needed).
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  const info = await r.json().catch(() => ({}));
  if (!r.ok || !info.sub) return res.status(401).json({ error: 'Invalid Google token' });
  if (info.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Token audience mismatch' });
  if (info.email_verified !== 'true' && info.email_verified !== true) {
    return res.status(401).json({ error: 'Email not verified' });
  }

  // Upsert the owner record.
  const key = `owner:${info.sub}`;
  const existing = await kvGet(key);
  const owner = {
    sub: info.sub,
    email: info.email,
    name: info.name || existing?.name || info.email,
    picture: info.picture || existing?.picture || '',
    createdAt: existing?.createdAt || new Date().toISOString(),
    paddleCustomerId: existing?.paddleCustomerId || null,
  };
  await kvSet(key, owner);

  // Create a session.
  const token = crypto.randomBytes(32).toString('hex');
  await kvSetEx(`session:${token}`, { sub: info.sub, exp: Date.now() + SESSION_TTL * 1000 }, SESSION_TTL);
  res.setHeader('Set-Cookie', sessionCookie(token, isSecure(req)));
  return res.status(200).json({ owner: publicOwner(owner) });
}

// ── Session helpers ─────────────────────────────────────────────────
function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)) : null;
}

async function currentOwner(req, { kvGet }) {
  const token = readSessionToken(req);
  if (!token) return null;
  const session = await kvGet(`session:${token}`);
  if (!session || (session.exp && session.exp < Date.now())) return null;
  return kvGet(`owner:${session.sub}`);
}

function isSecure(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return proto.split(',')[0].trim() === 'https';
  return !/^localhost|^127\.0\.0\.1/.test(req.headers.host || '');
}
function sessionCookie(token, secure) {
  return `${SESSION_COOKIE}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}
function clearCookie(secure) {
  return `${SESSION_COOKIE}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/; Max-Age=0`;
}

function publicOwner(o) {
  return { sub: o.sub, email: o.email, name: o.name, picture: o.picture };
}

const CUSTOM_KEY = 'custom_properties';

// ── Owner property CRUD ─────────────────────────────────────────────
async function listProperties(res, owner, { kvGet }) {
  const slugs = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  const subs = await Promise.all(slugs.map(s => kvGet(`sub:${s}`)));
  const properties = slugs
    .map((slug, i) => {
      const c = customMap[slug];
      if (!c || c.ownerSub !== owner.sub) return null;
      // Return the full record (owner's own data) so the edit form can populate.
      return {
        ...c,
        status: c.status || 'pending_review',
        subscription: subs[i] ? { status: subs[i].status } : null,
      };
    })
    .filter(Boolean);
  return res.status(200).json({ properties });
}

// Per-owner analytics, scoped to the owner's listings (propId = c_<slug>).
// Mirrors the per-property aggregation in api/dashboard.js (same KV keys).
const PEVENTS = ['listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download'];

async function ownerAnalytics(req, res, owner, { kvGet, kvPipeline }) {
  const period = ['7d', '30d', '90d', 'all'].includes(req.query.period) ? req.query.period : '30d';
  const slugs = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  const mine = slugs.filter(s => customMap[s] && customMap[s].ownerSub === owner.sub);
  if (!mine.length) return res.status(200).json({ period, properties: [], totals: zeroEvents() });

  const propIds = mine.map(s => 'c_' + s);
  const num = v => parseInt(v) || 0;
  const stats = Object.fromEntries(propIds.map(id => [id, zeroEvents()]));

  if (period === 'all') {
    const cmds = [];
    propIds.forEach(id => PEVENTS.forEach(e => cmds.push(['GET', `prop:${id}:${e}`])));
    const out = await kvPipeline(cmds);
    let p = 0;
    propIds.forEach(id => PEVENTS.forEach(e => { stats[id][e] = num(out[p++]); }));
  } else {
    const nDays = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const days = [];
    for (let i = nDays - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().split('T')[0]); }
    const out = await kvPipeline(days.map(d => ['HGETALL', `pstats:${d}`]));
    const idSet = new Set(propIds);
    out.forEach(h => {
      if (!Array.isArray(h)) return;
      for (let i = 0; i < h.length; i += 2) {
        const field = h[i]; const idx = field.lastIndexOf(':');
        if (idx < 0) continue;
        const pid = field.slice(0, idx); const ev = field.slice(idx + 1);
        if (idSet.has(pid) && PEVENTS.includes(ev)) stats[pid][ev] += num(h[i + 1]);
      }
    });
  }

  const properties = mine.map(slug => {
    const s = stats['c_' + slug];
    return { slug, name: customMap[slug].name, ...s, engagement: s.listing_view + s.details_open };
  });
  const totals = zeroEvents();
  properties.forEach(p => PEVENTS.forEach(e => { totals[e] += p[e]; }));
  totals.engagement = totals.listing_view + totals.details_open;
  return res.status(200).json({ period, properties, totals });
}
function zeroEvents() { return Object.fromEntries(PEVENTS.map(e => [e, 0])); }

async function saveProperty(req, res, owner, { kvGet, kvSet }) {
  const data = req.body?.data || {};
  const name = cleanStr(data.name);
  if (!name) return res.status(400).json({ error: 'Property name is required' });

  const all = (await kvGet(CUSTOM_KEY)) || {};
  let slug = cleanStr(req.body?.slug);

  if (slug) {
    // Edit: must already exist and belong to this owner.
    if (!all[slug] || all[slug].ownerSub !== owner.sub) {
      return res.status(403).json({ error: 'Not your listing' });
    }
  } else {
    // Create: derive a unique slug.
    const base = slugify(name);
    slug = base; let n = 2;
    while (all[slug]) slug = `${base}-${n++}`;
  }

  const existing = all[slug];
  const status = !existing ? 'pending_review'
    : existing.status === 'rejected' ? 'pending_review' : existing.status;

  all[slug] = buildOwnerListing(slug, data, existing, owner.sub, status);
  await kvSet(CUSTOM_KEY, all);

  // Track ownership index.
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  if (!owned.includes(slug)) { owned.push(slug); await kvSet(`owner_listings:${owner.sub}`, owned); }

  return res.status(200).json({ ok: true, slug, status });
}

async function deleteProperty(req, res, owner, { kvGet, kvSet, kvDel }) {
  const slug = cleanStr(req.query.slug) || cleanStr(req.body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  const all = (await kvGet(CUSTOM_KEY)) || {};
  if (!all[slug] || all[slug].ownerSub !== owner.sub) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  delete all[slug];
  await kvSet(CUSTOM_KEY, all);
  const owned = ((await kvGet(`owner_listings:${owner.sub}`)) || []).filter(s => s !== slug);
  await kvSet(`owner_listings:${owner.sub}`, owned);
  await kvDel(`sub:${slug}`);
  return res.status(200).json({ ok: true });
}

// Build a custom-listing record from owner-submitted form data. Mirrors the
// shape api/listings.js stores so the public site + admin render it uniformly.
function buildOwnerListing(slug, data, existing, ownerSub, status) {
  const bed = parseInt(data.bedrooms) || 0;
  const bath = parseInt(data.bathrooms) || 0;
  const bbFeature = (bed || bath)
    ? [`${bed || '?'} Bedroom${bed === 1 ? '' : 's'} · ${bath || '?'} Bathroom${bath === 1 ? '' : 's'}`]
    : [];
  const location = cleanStr(data.mapLink || data.location);
  return {
    slug, custom: true,
    name: cleanStr(data.name),
    tag: cleanStr(data.tag || data.area),
    unitType: cleanStr(data.unitType),
    location: /^https?:\/\//.test(location) ? location : '',
    icalUrl: /^https?:\/\//.test(cleanStr(data.icalUrl)) ? cleanStr(data.icalUrl) : (existing?.icalUrl || ''),
    coverPhotoId: existing?.coverPhotoId || '',
    coverPosition: existing?.coverPosition || '50% 50%',
    mapEmbed: existing?.mapEmbed || '',
    overview: cleanStr(data.overview),
    features: [...bbFeature, ...cleanLines(data.features)],
    inclusions: cleanLines(data.inclusions),
    yearlyInclusions: cleanLines(data.yearlyInclusions),
    locationHighlights: cleanLines(data.locationHighlights),
    monthly: cleanStr(data.monthly),
    yearly: cleanStr(data.yearly),
    yearly2: cleanStr(data.yearly2),
    folder: extractFolderId(data.photosLink || data.folder),
    waNumber: cleanStr(data.waNumber).replace(/[^0-9]/g, ''),
    waContactName: cleanStr(data.waContactName),
    bedrooms: bed || undefined,
    bathrooms: bath || undefined,
    bookedRanges: existing?.bookedRanges || [],
    hidden: false,
    ownerSub,
    status,
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

function cleanStr(v) { return typeof v === 'string' ? v.trim() : ''; }
function cleanLines(a) {
  if (typeof a === 'string') a = a.split('\n');
  return Array.isArray(a) ? a.map(s => String(s).trim()).filter(Boolean).slice(0, 40) : [];
}
function slugify(name) {
  return cleanStr(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'property';
}
function extractFolderId(url) {
  const s = cleanStr(url);
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{10,}$/.test(s) ? s : '');
}
