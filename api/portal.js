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
import { logError } from '../lib/errlog.js';

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
      const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
      return res.status(200).json({ owner: { ...publicOwner(owner), hasListings: owned.length > 0 } });
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
      return listProperties(res, owner, { kvGet, kvSet });
    }
    if (action === 'property' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return saveProperty(req, res, owner, { kvGet, kvSet, kvDel });
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
    // Redeem a promo code to activate a listing for free (stopgap while card
    // billing is offline). Writes an active sub:{slug} with promo metadata.
    if (action === 'redeem-promo' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return redeemPromo(req, res, owner, { kvGet, kvSet });
    }
    // Pre-fill the listing form from a public Airbnb / Booking.com page.
    if (action === 'import-listing' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return importListing(req, res);
    }

    // ── Agent account actions (favourites, notes, shortlists, profile) ──
    if (action === 'favorite' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return toggleFavorite(req, res, owner, { kvSet });
    }
    if (action === 'note' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return setNote(req, res, owner, { kvSet });
    }
    if (action === 'list' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return handleList(req, res, owner, { kvSet, kvDel });
    }
    if (action === 'profile' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return saveProfile(req, res, owner, { kvGet, kvSet });
    }
    // Public, unauthenticated: an agent's shareable profile or a shared shortlist.
    if (action === 'agent-public' && req.method === 'GET') {
      return agentPublic(req, res, { kvGet });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    await logError(kvUrl, kvToken, `portal:${action || req.method}`, e);
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
    // Agent-account capabilities — preserved across sign-ins.
    favorites: Array.isArray(existing?.favorites) ? existing.favorites : [],
    notes: existing?.notes && typeof existing.notes === 'object' ? existing.notes : {},
    lists: Array.isArray(existing?.lists) ? existing.lists : [],
    profile: existing?.profile && typeof existing.profile === 'object' ? existing.profile : {},
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
  return {
    sub: o.sub, email: o.email, name: o.name, picture: o.picture,
    favorites: Array.isArray(o.favorites) ? o.favorites : [],
    notes: o.notes && typeof o.notes === 'object' ? o.notes : {},
    lists: Array.isArray(o.lists) ? o.lists : [],
    profile: o.profile && typeof o.profile === 'object' ? o.profile : {},
  };
}

// ── Agent account: favourites, notes, shortlists, public profile ─────
function normSlug(s) { return cleanStr(s).toLowerCase().replace(/[^a-z0-9-]/g, ''); }

async function toggleFavorite(req, res, owner, { kvSet }) {
  const slug = normSlug(req.body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  const favs = Array.isArray(owner.favorites) ? owner.favorites : [];
  const i = favs.indexOf(slug);
  if (i >= 0) favs.splice(i, 1); else favs.unshift(slug);
  owner.favorites = favs;
  await kvSet(`owner:${owner.sub}`, owner);
  return res.status(200).json({ ok: true, favorited: i < 0, favorites: favs });
}

async function setNote(req, res, owner, { kvSet }) {
  const slug = normSlug(req.body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  const text = cleanStr(req.body?.text).slice(0, 2000);
  const notes = owner.notes && typeof owner.notes === 'object' ? owner.notes : {};
  if (text) notes[slug] = text; else delete notes[slug];
  owner.notes = notes;
  await kvSet(`owner:${owner.sub}`, owner);
  return res.status(200).json({ ok: true, notes });
}

async function handleList(req, res, owner, { kvSet, kvDel }) {
  owner.lists = Array.isArray(owner.lists) ? owner.lists : [];
  const lists = owner.lists;
  const op = cleanStr(req.body?.op);
  const findList = id => lists.find(l => l.id === id);
  if (op === 'create') {
    lists.unshift({ id: crypto.randomBytes(6).toString('hex'), name: cleanStr(req.body?.name).slice(0, 80) || 'Untitled list', slugs: [], shareId: null });
  } else if (op === 'rename') {
    const l = findList(cleanStr(req.body?.id)); if (!l) return res.status(404).json({ error: 'List not found' });
    l.name = cleanStr(req.body?.name).slice(0, 80) || l.name;
  } else if (op === 'delete') {
    const id = cleanStr(req.body?.id); const l = findList(id);
    if (l?.shareId) await kvDel(`share:${l.shareId}`);
    owner.lists = lists.filter(x => x.id !== id);
  } else if (op === 'add' || op === 'remove') {
    const l = findList(cleanStr(req.body?.id)); if (!l) return res.status(404).json({ error: 'List not found' });
    const slug = normSlug(req.body?.slug); if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const i = l.slugs.indexOf(slug);
    if (op === 'add' && i < 0) l.slugs.push(slug);
    if (op === 'remove' && i >= 0) l.slugs.splice(i, 1);
  } else if (op === 'share') {
    const l = findList(cleanStr(req.body?.id)); if (!l) return res.status(404).json({ error: 'List not found' });
    if (!l.shareId) { l.shareId = crypto.randomBytes(6).toString('hex'); await kvSet(`share:${l.shareId}`, { sub: owner.sub, listId: l.id }); }
  } else if (op === 'unshare') {
    const l = findList(cleanStr(req.body?.id)); if (!l) return res.status(404).json({ error: 'List not found' });
    if (l.shareId) { await kvDel(`share:${l.shareId}`); l.shareId = null; }
  } else {
    return res.status(400).json({ error: 'Unknown list op' });
  }
  await kvSet(`owner:${owner.sub}`, owner);
  return res.status(200).json({ ok: true, lists: owner.lists });
}

async function saveProfile(req, res, owner, { kvGet, kvSet }) {
  const p = owner.profile && typeof owner.profile === 'object' ? owner.profile : {};
  const displayName = cleanStr(req.body?.displayName).slice(0, 80) || owner.name || '';
  p.displayName = displayName;
  p.agency = cleanStr(req.body?.agency).slice(0, 80);
  p.waNumber = cleanStr(req.body?.waNumber).replace(/[^0-9]/g, '');
  p.public = !!req.body?.public;
  // Optional custom avatar: a small in-browser-compressed data URL. Cap size so
  // the account record stays light (auth/me returns it on every load).
  if (req.body?.photo !== undefined) {
    const photo = cleanStr(req.body.photo);
    if (!photo) p.photo = '';
    else if (/^data:image\/(png|jpe?g|webp);base64,/.test(photo) && photo.length <= 200000) p.photo = photo;
  }
  // Stable public handle, generated once and never reassigned.
  if (!p.handle) {
    const base = slugify(displayName || owner.email || 'agent');
    let handle = base, n = 2;
    while (true) {
      const taken = await kvGet(`handle:${handle}`);
      if (!taken || taken === owner.sub) break;
      handle = `${base}-${n++}`;
    }
    p.handle = handle;
    await kvSet(`handle:${handle}`, owner.sub);
  }
  // Best-effort CRM link by WhatsApp number (same CRM call as home-stats.js).
  if (p.waNumber && !p.crmAgentId) {
    try {
      const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
      const r = await fetch(`${crmBase}/api/supabase`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_agents' }) });
      const agents = await r.json();
      if (Array.isArray(agents)) {
        const tail = p.waNumber.slice(-8);
        const match = agents.find(a => a.wa_num && String(a.wa_num).replace(/[^0-9]/g, '').endsWith(tail));
        if (match) p.crmAgentId = match.id || match.agent_id || null;
      }
    } catch {}
  }
  owner.profile = p;
  await kvSet(`owner:${owner.sub}`, owner);
  return res.status(200).json({ ok: true, profile: p });
}

// Public read: an agent's shareable profile (by handle) or a shared shortlist
// (by share id). Returns only a safe profile subset + the villa slugs to show.
async function agentPublic(req, res, { kvGet }) {
  const handle = cleanStr(req.query.handle);
  const share = cleanStr(req.query.share);
  let owner = null, slugs = [], listName = null;
  if (share) {
    const map = await kvGet(`share:${share}`);
    if (!map?.sub) return res.status(404).json({ error: 'Not found' });
    owner = await kvGet(`owner:${map.sub}`);
    const list = (owner?.lists || []).find(l => l.id === map.listId);
    if (!owner || !list) return res.status(404).json({ error: 'Not found' });
    slugs = list.slugs || [];
    listName = list.name || null;
  } else if (handle) {
    const sub = await kvGet(`handle:${handle}`);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    owner = await kvGet(`owner:${sub}`);
    if (!owner) return res.status(404).json({ error: 'Not found' });
    // Contact details resolve for any existing handle (the agent opts in by
    // sharing with ?a=handle); their saved-villa list only shows when public.
    slugs = owner.profile?.public && Array.isArray(owner.favorites) ? owner.favorites : [];
  } else {
    return res.status(400).json({ error: 'Missing handle or share' });
  }
  const pr = owner.profile || {};
  return res.status(200).json({
    profile: {
      displayName: pr.displayName || owner.name || 'Agent',
      agency: pr.agency || '',
      waNumber: pr.waNumber || '',
      photo: pr.photo || owner.picture || '',
      picture: pr.photo || owner.picture || '',
      handle: pr.handle || '',
      public: !!pr.public,
    },
    listName,
    slugs,
  });
}

const CUSTOM_KEY = 'custom_properties';

// Promo codes (KV: `promo_codes`). Seeded lazily with these defaults the first
// time a code is redeemed, so FREEMONTH works out of the box. To add or disable
// codes, edit the `promo_codes` KV value (e.g. add a key, set active:false, or
// cap maxRedemptions). `type:'free_month'` ⇒ activates a listing for
// durationDays at no charge.
const DEFAULT_PROMOS = {
  FREEMONTH: { type: 'free_month', durationDays: 30, active: true, maxRedemptions: null, redemptions: 0 },
};

// Redeem a promo code against one of the owner's listings. Validates ownership
// and the code, then writes an active sub:{slug} (status 'active' so the listing
// goes public) tagged source:'promo' with an expiry, and records the redemption.
async function redeemPromo(req, res, owner, { kvGet, kvSet }) {
  const slug = normSlug(req.body?.slug);
  const code = cleanStr(req.body?.code).toUpperCase();
  if (!slug || !code) return res.status(400).json({ error: 'Enter your promo code.' });

  // Ownership check.
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  if (!owned.includes(slug) || !customMap[slug] || customMap[slug].ownerSub !== owner.sub) {
    return res.status(403).json({ error: 'That property isn’t yours.' });
  }

  // Load the promo store, seeding defaults so FREEMONTH works on a fresh install.
  let promos = (await kvGet('promo_codes')) || {};
  for (const k of Object.keys(DEFAULT_PROMOS)) { if (!promos[k]) promos[k] = { ...DEFAULT_PROMOS[k] }; }
  const promo = promos[code];
  if (!promo || promo.active === false) return res.status(400).json({ error: 'That code isn’t valid.' });
  if (promo.maxRedemptions != null && (promo.redemptions || 0) >= promo.maxRedemptions) {
    return res.status(400).json({ error: 'That code has been fully redeemed.' });
  }

  // Don't double-apply over an already-active subscription.
  const existing = await kvGet(`sub:${slug}`);
  if (existing && existing.status === 'active') {
    return res.status(200).json({ ok: true, alreadyActive: true, subscription: { status: 'active', source: existing.source || null, expiresAt: existing.expiresAt || null } });
  }

  const now = Date.now();
  const days = promo.durationDays || 30;
  const expiresAt = now + days * 86400000;
  await kvSet(`sub:${slug}`, { status: 'active', source: 'promo', code, plan: 'promo_free_month', startedAt: now, expiresAt });

  promo.redemptions = (promo.redemptions || 0) + 1;
  promo.redeemedBy = (promo.redeemedBy || []).concat([{ sub: owner.sub, slug, at: now }]).slice(-1000);
  promos[code] = promo;
  await kvSet('promo_codes', promos);

  return res.status(200).json({ ok: true, subscription: { status: 'active', source: 'promo', expiresAt } });
}

// ── Owner property CRUD ─────────────────────────────────────────────
async function listProperties(res, owner, { kvGet, kvSet }) {
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  // Claim any listings an admin pre-assigned to this owner's email.
  await claimByEmail(owner, customMap, { kvGet, kvSet });
  const slugs = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const subs = await Promise.all(slugs.map(s => kvGet(`sub:${s}`)));
  const properties = slugs
    .map((slug, i) => {
      const c = customMap[slug];
      if (!c || c.ownerSub !== owner.sub) return null;
      // Return the full record (owner's own data) so the edit form can populate.
      return {
        ...c,
        status: c.status || 'pending_review',
        comped: !!c.comped,
        subscription: subs[i] ? { status: subs[i].status, source: subs[i].source || null, expiresAt: subs[i].expiresAt || null } : null,
      };
    })
    .filter(Boolean);
  return res.status(200).json({ properties });
}

// Link listings an admin pre-assigned to owner.email (via assign-owner) to this
// signed-in owner: set ownerSub and add to the owner_listings index. Mutates
// customMap in place and persists if anything changed.
async function claimByEmail(owner, customMap, { kvGet, kvSet }) {
  if (!owner.email) return;
  const email = owner.email.toLowerCase();
  const toClaim = Object.keys(customMap).filter(slug => {
    const c = customMap[slug];
    return c && c.ownerEmail && String(c.ownerEmail).toLowerCase() === email && c.ownerSub !== owner.sub;
  });
  if (!toClaim.length) return;
  for (const slug of toClaim) customMap[slug].ownerSub = owner.sub;
  await kvSet(CUSTOM_KEY, customMap);
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  let changed = false;
  for (const slug of toClaim) if (!owned.includes(slug)) { owned.push(slug); changed = true; }
  if (changed) await kvSet(`owner_listings:${owner.sub}`, owned);
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

  // Fixed 14-day window for the per-villa sparkline + "this week" counts,
  // independent of the selected period.
  const sdays = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); sdays.push(d.toISOString().split('T')[0]); }
  const sout = await kvPipeline(sdays.map(d => ['HGETALL', `pstats:${d}`]));
  const spark = Object.fromEntries(propIds.map(id => [id, Array(14).fill(0)]));
  const shares7 = Object.fromEntries(propIds.map(id => [id, 0]));
  const wa7 = Object.fromEntries(propIds.map(id => [id, 0]));
  sout.forEach((h, di) => {
    if (!Array.isArray(h)) return;
    for (let i = 0; i < h.length; i += 2) {
      const f = h[i]; const idx = f.lastIndexOf(':');
      if (idx < 0) continue;
      const pid = f.slice(0, idx), ev = f.slice(idx + 1), n = num(h[i + 1]);
      if (!spark[pid]) continue;
      if (ev === 'listing_view' || ev === 'details_open') spark[pid][di] += n;
      if (di >= 7) {
        if (ev === 'share') shares7[pid] += n;
        if (ev === 'whatsapp_click') wa7[pid] += n;
      }
    }
  });

  const properties = mine.map(slug => {
    const s = stats['c_' + slug];
    const id = 'c_' + slug;
    return { slug, name: customMap[slug].name, ...s, engagement: s.listing_view + s.details_open,
             spark: spark[id], shares7: shares7[id], wa7: wa7[id] };
  });
  const totals = zeroEvents();
  properties.forEach(p => PEVENTS.forEach(e => { totals[e] += p[e]; }));
  totals.engagement = totals.listing_view + totals.details_open;
  return res.status(200).json({ period, properties, totals });
}
function zeroEvents() { return Object.fromEntries(PEVENTS.map(e => [e, 0])); }

async function saveProperty(req, res, owner, { kvGet, kvSet, kvDel }) {
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

  // Drop any cached auto-derived cover so a freshly added/changed photo folder
  // is re-scanned by api/listings.js on the next read.
  if (all[slug].folder) await kvDel(`autocover:${all[slug].folder}`);

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
    // Fields below: take the submitted value when the form provided one,
    // otherwise keep whatever the listing already had (so editing through a
    // form that omits a field never silently wipes it).
    inclusions: data.inclusions !== undefined ? cleanLines(data.inclusions) : (existing?.inclusions || []),
    yearlyInclusions: data.yearlyInclusions !== undefined ? cleanLines(data.yearlyInclusions) : (existing?.yearlyInclusions || []),
    locationHighlights: data.locationHighlights !== undefined ? cleanLines(data.locationHighlights) : (existing?.locationHighlights || []),
    monthly: cleanStr(data.monthly),
    yearly: cleanStr(data.yearly),
    yearly2: data.yearly2 !== undefined ? cleanStr(data.yearly2) : (existing?.yearly2 || ''),
    folder: extractFolderId(data.photosLink || data.folder),
    waNumber: cleanStr(data.waNumber).replace(/[^0-9]/g, ''),
    waContactName: cleanStr(data.waContactName),
    bedrooms: bed || undefined,
    bathrooms: bath || undefined,
    bookedRanges: existing?.bookedRanges || [],
    hidden: false,
    // Ownership + complimentary flags are never set from the edit form — always
    // carried over so an owner edit can't strip its own free/linked status.
    ownerSub,
    ownerEmail: existing?.ownerEmail || null,
    comped: !!existing?.comped,
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

// ── Listing import ───────────────────────────────────────────────────
// Owner pastes their Airbnb / Booking.com URL; we fetch the public page
// server-side and extract what those pages expose to link previews
// (OG tags, JSON-LD, and Airbnb's "Villa in Canggu · 2 bedrooms · 2 baths"
// summary line). Hostname allowlist + https-only + re-check after
// redirects, so this can't be used to probe internal URLs (SSRF).
const IMPORT_HOSTS = /(^|\.)airbnb\.[a-z.]{2,6}$|(^|\.)booking\.com$/i;

async function importListing(req, res) {
  let url;
  try { url = new URL(String(req.body?.url || '').trim()); } catch { return res.status(400).json({ error: 'That does not look like a valid link' }); }
  if (url.protocol !== 'https:' || !IMPORT_HOSTS.test(url.hostname)) {
    return res.status(400).json({ error: 'Only Airbnb or Booking.com listing links are supported' });
  }
  let r;
  try {
    r = await fetch(url.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return res.status(422).json({ error: 'Could not reach that page — check the link and try again' });
  }
  if (!IMPORT_HOSTS.test(new URL(r.url).hostname)) {
    return res.status(422).json({ error: 'The link redirected somewhere unexpected' });
  }
  if (!r.ok) return res.status(422).json({ error: 'Could not open the listing (HTTP ' + r.status + '). Make sure it is public.' });
  const html = (await r.text()).slice(0, 2500000);
  const fields = extractListingFields(html, new URL(r.url).hostname);
  if (!fields.name && !fields.overview && fields.bedrooms == null) {
    return res.status(422).json({ error: 'Could not read details from that page — you can still fill the form manually' });
  }
  return res.status(200).json({ fields });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ');
}
function metaContent(html, prop) {
  const tag = (html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>', 'i')) || [])[0];
  if (!tag) return '';
  const m = tag.match(/content=["']([^"']*)["']/i);
  return m ? decodeEntities(m[1]).trim() : '';
}

function extractListingFields(html, host) {
  const out = {};
  const title = metaContent(html, 'og:title') || decodeEntities((html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '').trim();
  const desc = metaContent(html, 'og:description') || metaContent(html, 'description');

  // JSON-LD: Booking.com ships a Hotel schema (name/description/address);
  // some Airbnb pages ship VacationRental.
  let ld = null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const hit = arr.find(x => x && /Hotel|LodgingBusiness|VacationRental|Apartment|House|Product/i.test(String(x['@type'])));
      if (hit) ld = hit;
    } catch {}
  }

  // Name — strip the marketing tail Airbnb/Booking append to titles.
  let name = (ld && typeof ld.name === 'string' && ld.name) || title;
  name = name
    .split(/ [-–—|·] (?:Villas?|Apartments?|Houses?|Condos?|[A-Za-z ]*for Rent|Airbnb|Booking\.com|Updated \d{4}).*$/i)[0]
    .replace(/\s*[-–—|]\s*(Airbnb|Booking\.com)\s*$/i, '')
    .trim();
  if (name) out.name = name.slice(0, 120);

  const ldDescRaw = (ld && typeof ld.description === 'string') ? decodeEntities(ld.description) : '';
  const searchable = title + ' · ' + (desc || '') + ' · ' + ldDescRaw;

  // Bedrooms / bathrooms — Airbnb's og:description is a summary line like
  // "Villa in Canggu · ★4.87 · 2 bedrooms · 2 beds · 2.5 baths";
  // Booking buries counts in the JSON-LD description prose.
  const br = searchable.match(/(\d+(?:\.\d+)?)\s*bedroom/i) || searchable.match(/(\d+)\s*BR\b/i);
  if (br) out.bedrooms = Math.round(parseFloat(br[1]));
  else if (/\bstudio\b/i.test(searchable)) out.bedrooms = 0;
  const ba = searchable.match(/(\d+(?:\.\d+)?)\s*(?:private\s+|shared\s+)?bath/i);
  if (ba) out.bathrooms = Math.ceil(parseFloat(ba[1]));

  // Unit type — "Villa in Canggu" prefix of the summary line.
  const type = searchable.match(/\b(Villa|Apartment|House|Guesthouse|Guest suite|Townhouse|Loft|Bungalow|Condo|Cabin|Studio|Serviced apartment)\b/i);
  if (type) out.unitType = (out.bedrooms ? out.bedrooms + 'BR ' : '') + type[1];

  // Area — JSON-LD address wins; else the "in Canggu, Bali" fragment.
  if (ld && ld.address && typeof ld.address === 'object') {
    const parts = [ld.address.addressLocality, ld.address.addressRegion].filter(v => typeof v === 'string' && v.trim());
    if (parts.length) out.area = parts.slice(0, 2).join(' · ');
  }
  if (!out.area) {
    const loc = searchable.match(/\bin ([A-Z][A-Za-z' ]{2,30}(?:,\s*[A-Z][A-Za-z' ]{2,30})?)/);
    if (loc) out.area = loc[1].split(',').map(s => s.trim()).slice(0, 2).join(' · ');
  }

  // Overview — prefer long JSON-LD prose; skip Airbnb's meta summary line.
  const isSummaryLine = (s) => /·\s*★|\d\s*bedroom.*·.*bed/i.test(s);
  const best = [ldDescRaw.trim(), desc].filter(s => s && !isSummaryLine(s)).sort((a, b) => b.length - a.length)[0];
  if (best) out.overview = best.slice(0, 1200);

  out.source = /airbnb/i.test(host) ? 'airbnb' : 'booking';
  return out;
}
