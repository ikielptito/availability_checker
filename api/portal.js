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
import { rankStep } from '../lib/photorank.js';
import { parseIcsBookedDates } from './ical.js';
import { isHostexSlug, propIdFor, loadHostexOwnerMap, resolveOwnedListing } from '../lib/owner-listings.js';
import { nextActions, fieldChecklist } from '../lib/next-actions.js';
import { driveConfigured, createPhotoFolder, folderLink, uploadPhotoFromUrl, uploadBytes } from '../lib/drive-photos.js';

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

  // Mutual exclusion for read-modify-write on a whole-blob key. Every listing
  // lives inside the single `custom_properties` value, so two concurrent
  // writers each read the map, edit their own entry and write the map back —
  // and the slower write silently discards the faster one, including OTHER
  // owners' listings. Maya's intake can fire many times in one second, which
  // is exactly how that window gets hit (16 Aug 2026).
  //
  // SET NX EX is atomic in Redis, so the first caller wins the lock and the
  // rest spin briefly. The TTL means a crashed holder can never wedge the key.
  async function kvWithLock(key, fn, { attempts = 25, waitMs = 200, ttl = 15 } = {}) {
    const lock = `lock:${key}`;
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let held = false;
    for (let i = 0; i < attempts; i++) {
      if (await kvCmd(['SET', lock, token, 'NX', 'EX', String(ttl)])) { held = true; break; }
      await new Promise(r => setTimeout(r, waitMs));
    }
    // Proceeding un-held after ~5s is still better than failing the write; the
    // lock is an optimisation against a narrow window, not a correctness gate.
    try {
      return await fn();
    } finally {
      // Only release a lock we still own — never one a later caller took over
      // after our TTL expired.
      if (held && await kvCmd(['GET', lock]) === token) await kvCmd(['DEL', lock]).catch(() => {});
    }
  }

  const action = req.query.action || '';

  try {
    if (action === 'config' && req.method === 'GET') {
      return res.status(200).json({
        googleClientId: GOOGLE_CLIENT_ID,
        billingReady: !!(process.env.CREEM_API_KEY && process.env.CREEM_PRODUCT_ID),
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
    // Full weekly performance report for one of the owner's listings — the
    // rich, sendable report shown under the portal's Reports tab. Two auth
    // modes: an owner session (portal UI) OR the CRM service secret (so Maya
    // can fetch any listing's report server-side to answer owner questions on
    // WhatsApp). Service mode skips the ownership check; sessions are scoped.
    if (action === 'report' && req.method === 'GET') {
      const svcSecret = process.env.LISTING_SYNC_SECRET;
      if (svcSecret && (req.headers.authorization || '') === `Bearer ${svcSecret}`) {
        return ownerReport(req, res, null, { kvGet, kvPipeline });
      }
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return ownerReport(req, res, owner, { kvGet, kvPipeline });
    }
    // Service-authed listing intake: Maya creates or updates a listing on
    // behalf of an owner she's chatting with on WhatsApp (identified by their
    // number/email). Always lands as pending_review — you still approve before
    // it goes live. Same trust boundary as the sync secret (server-to-server).
    if (action === 'intake' && req.method === 'POST') {
      const svcSecret = process.env.LISTING_SYNC_SECRET;
      if (!svcSecret || (req.headers.authorization || '') !== `Bearer ${svcSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return intakeListing(req, res, { kvGet, kvSet, kvDel, kvWithLock });
    }
    // Public tokenized report (no login) — powers the "View report" link Maya
    // sends owners on WhatsApp, so an owner without a Google account can still
    // open their report. The signed token IS the auth: it embeds the slug plus
    // an HMAC that can't be forged, and can't be used to enumerate other
    // listings. Same secret both apps share (LISTING_SYNC_SECRET).
    if (action === 'public-report' && req.method === 'GET') {
      const slug = verifyReportToken(req.query.token || '');
      if (!slug) return res.status(403).json({ error: 'Invalid or expired report link' });
      req.query.slug = slug;
      return ownerReport(req, res, null, { kvGet, kvPipeline });
    }
    // Redeem a promo code to activate a listing for free (stopgap while card
    // billing is offline). Writes an active sub:{slug} with promo metadata.
    if (action === 'redeem-promo' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return redeemPromo(req, res, owner, { kvGet, kvSet });
    }
    // AI photo sort for one of the owner's own listings. One scoring step per
    // call (serverless time limits) — the portal keeps calling until
    // { status: 'done' }. Folder is resolved server-side from the owner's
    // listing so an owner can only ever rank their own photo sets.
    if (action === 'rank' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return rankPhotos(req, res, owner, { kvGet, kvSet, kvDel });
    }
    // ── Listing-wizard support: draft autosave, native photo upload, manual order ──
    if (action === 'draft') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const key = `draft:${owner.sub}`;
      if (req.method === 'GET') return res.status(200).json({ draft: (await kvGet(key)) || null });
      if (req.method === 'POST') {
        const draft = req.body?.draft;
        if (draft && typeof draft === 'object') { draft.updatedAt = Date.now(); await kvSet(key, draft); }
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') { await kvDel(key); return res.status(200).json({ ok: true }); }
    }
    if (action === 'upload-photo' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return uploadPhoto(req, res);
    }
    if (action === 'photo-order' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return setPhotoOrder(req, res, owner, { kvGet, kvSet, kvDel });
    }
    if (action === 'place-search' && req.method === 'GET') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      return placeSearch(req, res);
    }
    // The two import actions are used by BOTH the owner portal (Google
    // session) and the admin console (password Bearer, same check as
    // api/listings.js) — an admin often enters a villa on the owner's behalf.
    const isAdminReq = () => {
      const adminPw = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD;
      return !!adminPw && (req.headers.authorization || '') === `Bearer ${adminPw}`;
    };
    // Pre-fill the listing form from a public Airbnb / Booking.com page.
    if (action === 'import-listing' && req.method === 'POST') {
      // Maya calls this too, with the shared service secret, when an owner
      // sends her their Airbnb/Booking link on WhatsApp — same scraper the
      // portal wizard uses, so there is one extraction path, not two.
      const svc = process.env.LISTING_SYNC_SECRET;
      const isService = !!svc && (req.headers.authorization || '') === `Bearer ${svc}`;
      const owner = isService ? null : await currentOwner(req, { kvGet });
      if (!owner && !isService && !isAdminReq()) return res.status(401).json({ error: 'Not signed in' });
      return importListing(req, res);
    }
    // Upload a chunk of extracted gallery photos into a Drive folder. The
    // frontend loops this (a few photos per call) so one slow CDN download
    // never times the whole import out.
    if (action === 'import-photos' && req.method === 'POST') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner && !isAdminReq()) return res.status(401).json({ error: 'Not signed in' });
      return importPhotos(req, res);
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
    // Share attribution readback: how many listing opens + WhatsApp enquiries
    // this agent's personalised links (?a=handle) have produced. Same hashes
    // api/track.js writes; this just lets the agent see their own numbers.
    if (action === 'my-stats' && req.method === 'GET') {
      const owner = await currentOwner(req, { kvGet });
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const handle = owner.profile?.handle;
      if (!handle) return res.status(200).json({ stats: null });
      const month = new Date().toISOString().slice(0, 7);
      const rows = await kvPipeline([
        ['HGET', 'attr:views', handle],
        ['HGET', 'attr:wa', handle],
        ['HGET', `attr:views:${month}`, handle],
        ['HGET', `attr:wa:${month}`, handle],
      ]);
      const n = i => parseInt(rows?.[i]) || 0;
      return res.status(200).json({ stats: { views: n(0), enquiries: n(1), viewsThisMonth: n(2), enquiriesThisMonth: n(3) } });
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
    creemCustomerId: existing?.creemCustomerId || null,
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
  // isNew lets the frontend distinguish a first-time signup from a returning
  // sign-in when reporting funnel events to /api/track.
  return res.status(200).json({ owner: publicOwner(owner), isNew: !existing });
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

// Signed report-link tokens: `${slug}~${hmac}`. The CRM computes the identical
// token (same LISTING_SYNC_SECRET + algorithm) to build the "View report" link
// it sends owners; this side verifies it. Unguessable, needs no KV storage, and
// stays stable per listing. Falls back to an empty-string key if the secret is
// unset (dev) — still consistent across both apps in that environment.
function reportSig(slug) {
  return crypto.createHmac('sha256', process.env.LISTING_SYNC_SECRET || '').update(String(slug)).digest('hex').slice(0, 16);
}
function verifyReportToken(token) {
  const t = String(token || '');
  const i = t.lastIndexOf('~');
  if (i < 0) return null;
  const slug = normSlug(t.slice(0, i));
  const sig = t.slice(i + 1);
  const expect = reportSig(slug);
  if (!slug || sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch { return null; }
  return slug;
}

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
      const r = await fetch(`${crmBase}/api/supabase`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.LISTING_SYNC_SECRET ? { Authorization: `Bearer ${process.env.LISTING_SYNC_SECRET}` } : {}) }, body: JSON.stringify({ action: 'get_agents' }) });
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
  // The one live offer (Ikiel, 23 Aug 2026): the first 25 villas list free,
  // for good. Modelled as a ten-year free period capped at 25 redemptions.
  FOUNDING25: { type: 'free_month', durationDays: 3650, active: true, maxRedemptions: 25, redemptions: 0 },
  // Legacy 30-day code — kept redeemable for anyone who already has it.
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
  const hostexMap = await loadHostexOwnerMap(kvGet);
  // Claim any listings an admin pre-assigned to this owner's email.
  await claimByEmail(owner, customMap, hostexMap, { kvGet, kvSet });
  const slugs = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  // Hostex catalog units are never billed — skip the sub:{slug} lookup.
  const subs = await Promise.all(slugs.map(s => isHostexSlug(s) ? null : kvGet(`sub:${s}`)));
  const properties = slugs
    .map((slug, i) => {
      const c = resolveOwnedListing(slug, customMap, hostexMap);
      if (!c || c.ownerSub !== owner.sub) return null;
      if (c.hostex) {
        // Samba-managed unit: always live, no billing, restricted editing —
        // the `hostex` flag is what the portal UI keys those restrictions on.
        return { ...c, status: 'live', comped: false, subscription: null };
      }
      // Return the full record (owner's own data) so the edit form can populate.
      // `checklist` is the record-only improvement queue (lib/next-actions.js) —
      // the My properties card surfaces its top item as the owner's next step.
      return {
        ...c,
        status: c.status || 'pending_review',
        comped: !!c.comped,
        subscription: subs[i] ? { status: subs[i].status, source: subs[i].source || null, expiresAt: subs[i].expiresAt || null } : null,
        checklist: fieldChecklist(c),
      };
    })
    .filter(Boolean);
  return res.status(200).json({ properties });
}

// Link listings an admin pre-assigned to owner.email (via assign-owner) to this
// signed-in owner: set ownerSub and add to the owner_listings index. Covers
// both stores — custom listings (mutates customMap in place, persists the hash)
// and Hostex catalog units (persists each claimed per-slug override).
async function claimByEmail(owner, customMap, hostexMap, { kvGet, kvSet }) {
  if (!owner.email) return;
  const email = owner.email.toLowerCase();
  const toClaim = Object.keys(customMap).filter(slug => {
    const c = customMap[slug];
    return c && c.ownerEmail && String(c.ownerEmail).toLowerCase() === email && c.ownerSub !== owner.sub;
  });
  const hostexClaim = Object.keys(hostexMap || {}).filter(slug => {
    const h = hostexMap[slug];
    return h && h.ownerEmail && String(h.ownerEmail).toLowerCase() === email && h.ownerSub !== owner.sub;
  });
  if (!toClaim.length && !hostexClaim.length) return;
  if (toClaim.length) {
    for (const slug of toClaim) customMap[slug].ownerSub = owner.sub;
    await kvSet(CUSTOM_KEY, customMap);
  }
  for (const slug of hostexClaim) {
    hostexMap[slug].ownerSub = owner.sub;
    // Persist only the override fields, not the merged catalog identity — read
    // the stored override fresh so we can't bake catalog defaults into KV.
    const override = (await kvGet(`listing:${slug}`)) || { slug };
    override.ownerSub = owner.sub;
    await kvSet(`listing:${slug}`, override);
  }
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  let changed = false;
  for (const slug of [...toClaim, ...hostexClaim]) if (!owned.includes(slug)) { owned.push(slug); changed = true; }
  if (changed) await kvSet(`owner_listings:${owner.sub}`, owned);
}

// Per-owner analytics, scoped to the owner's listings (propId = c_<slug>).
// Mirrors the per-property aggregation in api/dashboard.js (same KV keys).
const PEVENTS = ['listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download'];

async function ownerAnalytics(req, res, owner, { kvGet, kvPipeline }) {
  const period = ['7d', '30d', '90d', 'all'].includes(req.query.period) ? req.query.period : '30d';
  const slugs = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const records = {};
  const mine = slugs.filter(s => {
    const rec = resolveOwnedListing(s, customMap, hostexMap);
    if (!rec || rec.ownerSub !== owner.sub) return false;
    records[s] = rec;
    return true;
  });
  if (!mine.length) return res.status(200).json({ period, properties: [], totals: zeroEvents() });

  // Hostex units have always been tracked under their numeric hostexId —
  // propIdFor keeps that history; customs stay 'c_'+slug.
  const pidOf = Object.fromEntries(mine.map(s => [s, propIdFor(records[s])]));
  const propIds = mine.map(s => pidOf[s]);
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
    const id = pidOf[slug];
    const s = stats[id];
    return { slug, name: records[slug].name, ...s, engagement: s.listing_view + s.details_open,
             spark: spark[id], shares7: shares7[id], wa7: wa7[id] };
  });
  const totals = zeroEvents();
  properties.forEach(p => PEVENTS.forEach(e => { totals[e] += p[e]; }));
  totals.engagement = totals.listing_view + totals.details_open;
  return res.status(200).json({ period, properties, totals });
}
function zeroEvents() { return Object.fromEntries(PEVENTS.map(e => [e, 0])); }

// ── Weekly report for a single listing ──────────────────────────────
// Powers the portal's Reports tab. Everything here is real, owner-scoped data:
// this-week-vs-last-week engagement, a 7-day daily series, the view→enquiry
// funnel, per-listing agent reach (from the uprop:* sets track.js now writes),
// a portfolio benchmark, live occupancy parsed from the villa's own iCal, and
// the honestly-attributable slice of Maya's network activity. Anything we can't
// yet attribute per-villa is omitted rather than faked.
async function ownerReport(req, res, owner, { kvGet, kvPipeline }) {
  const slug = normSlug(req.query.slug || '');
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  const customMap = (await kvGet(CUSTOM_KEY)) || {};
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const prop = resolveOwnedListing(slug, customMap, hostexMap);
  // owner === null means the caller is service-authed (Maya server-side) and may
  // read any listing; a session caller is scoped to their own listings.
  if (!prop) return res.status(404).json({ error: 'Unknown listing' });
  if (owner && prop.ownerSub !== owner.sub) return res.status(403).json({ error: 'Not your listing' });
  const propId = propIdFor(prop);
  const num = v => parseInt(v) || 0;

  // 14 days of per-property stats hashes: [0] = 13 days ago … [13] = today.
  const days = [];
  for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d.toISOString().split('T')[0]); }
  const hashes = await kvPipeline(days.map(d => ['HGETALL', `pstats:${d}`]));

  // Parse each hash once into { propId: { event: n } }. We get this listing's
  // numbers AND every listing's (for the benchmark) in a single pass.
  const byDay = hashes.map(h => {
    const o = {};
    if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) {
      const f = h[i]; const idx = String(f).lastIndexOf(':'); if (idx < 0) continue;
      const pid = f.slice(0, idx), ev = f.slice(idx + 1);
      (o[pid] || (o[pid] = {}))[ev] = num(h[i + 1]);
    }
    return o;
  });

  const sumRange = (from, to, ev) => { let s = 0; for (let i = from; i <= to; i++) s += (byDay[i][propId]?.[ev] || 0); return s; };
  const metric = ev => ({ now: sumRange(7, 13, ev), prev: sumRange(0, 6, ev) });
  const listingV = metric('listing_view'), agentV = metric('details_open');
  const metrics = {
    // "Views" = anyone who opened the villa: agents opening it in the portal
    // (details_open) PLUS guests on shared links (listing_view). listing_view
    // alone reads as 0 for listings agents browse in-portal — which misleads
    // owners (0 views yet enquiries). Both are someone looking at the villa.
    views: { now: listingV.now + agentV.now, prev: listingV.prev + agentV.prev },
    agentViews: agentV,
    shares: metric('share'),
    enquiries: metric('whatsapp_click'),
    photoViews: metric('photo_view'),
    downloads: metric('photo_download'),
  };

  // Daily views series (portal opens + shared-link opens) for the last 7 days.
  const daily = days.slice(7).map(d => ({ date: d, views: 0 }));
  for (let i = 7; i <= 13; i++) daily[i - 7].views = (byDay[i][propId]?.listing_view || 0) + (byDay[i][propId]?.details_open || 0);

  // View → engaged → enquired this week: opened the villa → looked at the photos
  // → messaged. Not strictly nested, so the frontend clamps bar widths.
  const funnel = { viewed: metrics.views.now, engaged: metrics.photoViews.now, enquired: metrics.enquiries.now };

  // Real per-listing agent reach: union the daily agent-id sets.
  const wkKeys = days.slice(7).map(d => `uprop:${propId}:agents:${d}`);
  const pvKeys = days.slice(0, 7).map(d => `uprop:${propId}:agents:${d}`);
  const netKeys = days.slice(7).map(d => `unique:agents:${d}`);
  const [aNow, aPrev, netUnion] = await kvPipeline([
    ['SUNION', ...wkKeys], ['SUNION', ...pvKeys], ['SUNION', ...netKeys],
  ]);
  const agentsReached = {
    now: Array.isArray(aNow) ? aNow.length : 0,
    prev: Array.isArray(aPrev) ? aPrev.length : 0,
  };
  const networkAgents = Array.isArray(netUnion) ? netUnion.length : 0;

  // Benchmark: percentile rank of this listing's weekly enquiries among all
  // listings that had any activity this week.
  const peerEnq = {};
  for (let i = 7; i <= 13; i++) for (const [pid, evs] of Object.entries(byDay[i])) {
    // Peers = every real listing: customs ('c_'+slug) AND Hostex units (bare
    // numeric hostexId). Anything else in the stats hash isn't a listing.
    if (!pid.startsWith('c_') && !/^\d+$/.test(pid)) continue;
    peerEnq[pid] = (peerEnq[pid] || 0) + (evs.whatsapp_click || 0);
  }
  const peers = Object.values(peerEnq);
  const mine = peerEnq[propId] || 0;
  const below = peers.filter(v => v < mine).length;
  const benchmark = {
    metric: 'enquiries',
    peerCount: peers.length,
    percentile: peers.length > 1 ? Math.round((below / (peers.length - 1)) * 100) : null,
  };

  // Live occupancy. Custom listings: from the villa's own iCal (parser from
  // api/ical.js). Hostex units: from the Hostex calendar via our own
  // /api/calendar (same self-fetch pattern api/dashboard.js uses; the dev
  // harness mocks Hostex so this works locally too). Degrades to null — the
  // section hides — if no calendar or fetch fails.
  let occupancy = null;
  if (prop.hostex && prop.hostexId) {
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const horizon = new Date(today); horizon.setDate(horizon.getDate() + 90);
      const iso = d => d.toISOString().split('T')[0];
      const host = req.headers.host || 'sambarentals.com';
      const proto = req.headers['x-forwarded-proto'] || (/^localhost|^127\./.test(host) ? 'http' : 'https');
      const calRes = await fetch(`${proto}://${host}/api/calendar?id=${prop.hostexId}&start_date=${iso(today)}&end_date=${iso(horizon)}`);
      if (calRes.ok) {
        const cal = await calRes.json();
        const booked = new Set((cal?.data?.items || []).filter(i => i.status === 'booked').map(i => i.date));
        occupancy = buildOccupancy(booked);
      }
    } catch { /* keep occupancy null */ }
  } else if (prop.icalUrl && /^https?:\/\//.test(prop.icalUrl)) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const horizon = new Date(); horizon.setDate(horizon.getDate() + 90);
      const icsRes = await fetch(prop.icalUrl, { headers: { 'User-Agent': 'SambaRentals/1.0' } });
      if (icsRes.ok) occupancy = buildOccupancy(parseIcsBookedDates(await icsRes.text(), today, horizon.toISOString().split('T')[0]));
    } catch { /* keep occupancy null */ }
  }

  // Maya activity we can honestly attribute to THIS villa: the real agent
  // reach above, the live size of the network it sits in, and whether it's
  // currently eligible for the daily availability broadcast (has open nights).
  const maya = {
    agentsReached: agentsReached.now,
    networkAgents,
    broadcastEligible: occupancy ? occupancy.openNights > 0 : null,
  };

  // Bookings & revenue — Hostex-linked listings only. The Hostex reservation
  // feed carries every channel (Airbnb, Booking.com, direct…), so this is the
  // villa's full commercial picture, not just Samba-driven activity. Degrades
  // to null — the section hides — if the token is missing or the fetch fails.
  let bookings = null;
  if (prop.hostex && prop.hostexId && process.env.HOSTEX_TOKEN) {
    try { bookings = await buildBookings(prop.hostexId, days); }
    catch { /* keep bookings null */ }
  }

  // Listing strength → a recurring improvement nudge inside every report.
  // Samba-managed (Hostex) listings are curated by us, so no nudge there.
  const strength = isHostexSlug(slug) ? null : await listingStrength(prop);

  // Ranked next-best-actions (lib/next-actions.js) — the same engine the
  // properties checklist uses, here fed the full stats bundle. Report pages
  // render these instead of computing their own recommendations.
  const actions = nextActions(prop, {
    metrics, funnel, occupancy, benchmark, agentsReached: agentsReached.now,
  });

  return res.status(200).json({
    slug, name: prop.name || slug, area: prop.tag || prop.area || '', unitType: prop.unitType || '',
    listedAt: prop.createdAt || null, ownerName: (owner && owner.name) || prop.waContactName || '',
    week: { from: days[7], to: days[13] },
    metrics, daily, funnel, agentsReached, benchmark, occupancy, bookings, maya, strength,
    nextActions: actions,
  });
}

// ── Bookings & revenue from the Hostex reservation feed ─────────────
// "Net" = payment.total_amount — gross rate minus the channel's commission,
// i.e. what actually reaches the owner. Aggregates only: guest identity never
// enters the report payload (the report link is public-tokenized).
// One unfiltered page (newest-booked-first, 100 max) covers a villa's entire
// history at current volumes; revisit pagination if a property ever exceeds it.
const CHANNEL_LABELS = { airbnb: 'Airbnb', 'booking.com': 'Booking.com', booking: 'Booking.com', agoda: 'Agoda', direct: 'Direct', custom: 'Direct' };
async function buildBookings(hostexId, days) {
  const r = await fetch(`https://api.hostex.io/v3/reservations?property_id=${hostexId}&per_page=100&page=1`, {
    headers: { 'Hostex-Access-Token': process.env.HOSTEX_TOKEN },
  });
  if (!r.ok) return null;
  const all = ((await r.json())?.data?.reservations) || [];
  const nightsOf = x => Math.max(0, Math.round((new Date(x.check_out_date) - new Date(x.check_in_date)) / 86400000));
  const netOf = x => Number(x.payment?.total_amount ?? ((x.rates?.total_rate?.amount || 0) - (x.rates?.total_commission?.amount || 0))) || 0;
  const grossOf = x => Number(x.rates?.total_rate?.amount) || 0;
  const chOf = x => { const c = String(x.channel_type || '').toLowerCase(); return CHANNEL_LABELS[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Other'); };
  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);

  const active = all.filter(x => x.status !== 'cancelled');
  const bookedWithin = (from, to) => active.filter(x => { const b = String(x.booked_at || '').slice(0, 10); return b >= from && b <= to; });
  const wk = bookedWithin(days[7], days[13]);
  const pv = bookedWithin(days[0], days[6]);
  const today = new Date().toISOString().split('T')[0];
  // Forward book = every confirmed stay still to finish, including the guest
  // currently in-house. Full stay value, not pro-rated.
  const upcoming = active.filter(x => String(x.check_out_date) > today);
  const byChannel = {};
  wk.forEach(x => { byChannel[chOf(x)] = (byChannel[chOf(x)] || 0) + 1; });
  const upNights = sum(upcoming, nightsOf);
  return {
    currency: active[0]?.payment?.currency || active[0]?.rates?.total_rate?.currency || 'IDR',
    week: { count: wk.length, nights: sum(wk, nightsOf), gross: sum(wk, grossOf), net: sum(wk, netOf), byChannel },
    prevWeek: { count: pv.length, nights: sum(pv, nightsOf), net: sum(pv, netOf) },
    upcoming: { count: upcoming.length, nights: upNights, net: sum(upcoming, netOf), adr: upNights ? Math.round(sum(upcoming, netOf) / upNights) : null },
    cancelledThisWeek: all.filter(x => x.status === 'cancelled' && String(x.cancelled_at || '').slice(0, 10) >= days[7]).length,
  };
}

// Mirrors the wizard's client-side scoring so the number an owner sees in the
// wizard header and in their weekly report never disagree.
async function listingStrength(prop) {
  const has = v => !!(v && String(v).trim());
  const arr = v => (Array.isArray(v) ? v.filter(Boolean) : []);
  let photos = 0;
  if (prop.folder && process.env.GOOGLE_API_KEY) {
    try {
      const u = `https://www.googleapis.com/drive/v3/files?q='${prop.folder}'+in+parents+and+mimeType+contains+'image/'&fields=files(id)&key=${process.env.GOOGLE_API_KEY}&pageSize=30`;
      const d = await (await fetch(u)).json();
      photos = (d.files || []).length;
    } catch { photos = 5; }
  } else if (prop.folder) photos = 5;
  let s = 0; const tips = [];
  if (has(prop.name)) s += 10;
  s += photos >= 5 ? 25 : photos * 5;
  if (photos < 5) tips.push(photos ? `add ${5 - photos} more photos` : 'add photos');
  if (String(prop.overview || '').length >= 100) s += 15; else tips.push('write a longer overview');
  if (arr(prop.features).length >= 4) s += 10; else tips.push('pick at least 4 key features');
  if (has(prop.monthly)) s += 10; else tips.push('set a monthly price');
  if (has(prop.yearly)) s += 5; else tips.push('set a yearly price');
  if (has(prop.location)) s += 10; else tips.push('pin the location on the map');
  if (has(prop.icalUrl)) s += 10; else tips.push('connect your booking calendar');
  if (has(prop.waNumber)) s += 5; else tips.push('add a WhatsApp contact');
  return { score: Math.min(100, s), tips: tips.slice(0, 2) };
}

// Turn a Set of booked YYYY-MM-DD into the occupancy shape the report renders:
// next-30-night %, upcoming confirmed stays, and open gaps worth filling.
function buildOccupancy(bookedSet) {
  const iso = d => d.toISOString().split('T')[0];
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const cal = [];
  for (let i = 0; i < 60; i++) { const d = new Date(start); d.setDate(d.getDate() + i); cal.push({ date: iso(d), booked: bookedSet.has(iso(d)) }); }
  const bookedNights = cal.slice(0, 30).filter(c => c.booked).length;
  const contiguous = (want) => {
    const out = []; let s = null;
    for (let i = 0; i <= cal.length; i++) {
      const match = i < cal.length && cal[i].booked === want;
      if (match && s === null) s = i;
      else if (!match && s !== null) { out.push({ from: cal[s].date, to: cal[i - 1].date, nights: i - s }); s = null; }
    }
    return out;
  };
  return {
    pct: Math.round((bookedNights / 30) * 100),
    bookedNights, openNights: 30 - bookedNights,
    bookings: contiguous(true).slice(0, 5),
    openWindows: contiguous(false).filter(r => r.nights >= 2).slice(0, 4),
  };
}

async function saveProperty(req, res, owner, { kvGet, kvSet, kvDel }) {
  const data = req.body?.data || {};

  // Hostex catalog units: the owner may only maintain the four contact
  // fields. Identity, pricing, calendar, and photos are Samba-managed (the
  // catalog + admin console own them), so a portal edit must never touch
  // them — the admin write path would fight any structural change anyway.
  const hostexSlug = cleanStr(req.body?.slug);
  if (hostexSlug && isHostexSlug(hostexSlug)) {
    const override = (await kvGet(`listing:${hostexSlug}`)) || { slug: hostexSlug };
    if (override.ownerSub !== owner.sub) {
      return res.status(403).json({ error: 'Not your listing' });
    }
    if (data.waNumber !== undefined) override.waNumber = cleanStr(data.waNumber).replace(/[^0-9]/g, '');
    if (data.waContactName !== undefined) override.waContactName = cleanStr(data.waContactName);
    if (data.reportContactName !== undefined) override.reportContactName = cleanStr(data.reportContactName);
    if (data.reportWaNumber !== undefined) override.reportWaNumber = cleanStr(data.reportWaNumber).replace(/[^0-9]/g, '');
    override.updatedAt = Date.now();
    await kvSet(`listing:${hostexSlug}`, override);
    return res.status(200).json({ ok: true, slug: hostexSlug, status: 'live', hostex: true });
  }

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

// Maya-driven listing intake (service-authed). Creates or updates a custom
// listing on behalf of an owner Maya is chatting with on WhatsApp. The owner is
// identified by their WhatsApp number (ownerWa) and, when given, their email
// (so the listing auto-claims when they later sign in with Google). Always
// pending_review — never auto-live — and ownerWa keeps it out of the public
// feed until you approve it (see listingVisible).
async function intakeListing(req, res, { kvGet, kvSet, kvDel, kvWithLock }) {
  const body = req.body || {};
  const data = { ...(body.data || {}) };
  const waNumber = cleanStr(body.waNumber || data.waNumber).replace(/[^0-9]/g, '');
  const ownerEmail = cleanStr(body.ownerEmail || data.ownerEmail).toLowerCase();
  // `waNumber` is the listing's enquiry contact and it is meant to be reachable:
  // agents tap "Visit" on a villa to arrange a viewing with whoever runs it, so
  // an owner-managed listing without a number is a listing agents cannot act on.
  // It is carried by default, as every admin-entered listing already does.
  //
  // The exposure that DOES matter is that it ships in the unauthenticated
  // /api/listings payload, so it is readable by anyone, not just signed-in
  // agents — and the public /l/:slug page deliberately renders no WhatsApp link
  // precisely so a client forwarded the page can't bypass their agent. Closing
  // that gap means gating the listings feed behind the agent session; it is not
  // something to paper over by withholding the contact from agents.
  if (waNumber) data.waNumber = waNumber;
  if (body.waContactName && !data.waContactName) data.waContactName = body.waContactName;

  const name = cleanStr(data.name);
  // A name is required to CREATE; an update to an existing slug may omit it
  // (e.g. attaching photos only) — buildOwnerListing keeps the stored name.
  if (!name && !normSlug(body.slug || '')) return res.status(400).json({ error: 'Property name is required' });
  if (!waNumber && !ownerEmail) return res.status(400).json({ error: 'An owner WhatsApp number or email is required' });

  // The whole read-modify-write runs under the lock: without it two intakes
  // seconds apart can each write the full map and drop the other's listing.
  const out = await kvWithLock(CUSTOM_KEY, async () => {
    const all = (await kvGet(CUSTOM_KEY)) || {};
    let slug = normSlug(body.slug || '');

    // Does this owner already have a listing under this name? Maya submits
    // without a slug whenever she hasn't been told one, so "same owner, same
    // villa name" has to mean UPDATE — otherwise a re-submission silently
    // becomes casa-suhana-2. One burst produced 15 of them (16 Aug 2026).
    const ownedByCaller = (v) =>
      (waNumber && (String(v.waNumber || '').replace(/[^0-9]/g, '') === waNumber
                 || String(v.ownerWa || '').replace(/[^0-9]/g, '') === waNumber))
      || (ownerEmail && String(v.ownerEmail || '').toLowerCase() === ownerEmail);

    if (slug) {
      const ex = all[slug];
      if (!ex) return { code: 404, payload: { error: 'Unknown listing' } };
      // Maya may only edit the listing that belongs to the owner she's talking to.
      if (!ownedByCaller(ex)) return { code: 403, payload: { error: 'Listing belongs to a different owner' } };
    } else {
      const match = Object.keys(all).find(k =>
        ownedByCaller(all[k]) && slugify(cleanStr(all[k].name || '')) === slugify(name));
      if (match) {
        slug = match;
      } else {
        const base = slugify(name);
        slug = base; let n = 2;
        while (all[slug]) slug = `${base}-${n++}`;
      }
    }

    const existing = all[slug];
    // Every Maya-driven change still goes back to review — that is exactly what
    // she promises the owner ("it'll go live once Ikiel approves").
    const listing = buildOwnerListing(slug, data, existing, existing?.ownerSub || null, 'pending_review');
    listing.ownerEmail = ownerEmail || existing?.ownerEmail || null;
    listing.ownerWa = waNumber || existing?.ownerWa || '';   // owner-identity signal → stays gated
    listing.source = existing?.source || 'maya-intake';
    all[slug] = listing;
    await kvSet(CUSTOM_KEY, all);

    if (listing.folder) await kvDel(`autocover:${listing.folder}`);
    return { code: 200, payload: { ok: true, slug, status: listing.status, name: listing.name } };
  });

  return res.status(out.code).json(out.payload);
}

async function rankPhotos(req, res, owner, { kvGet, kvSet, kvDel }) {
  const slug = cleanStr(req.body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  const all = (await kvGet(CUSTOM_KEY)) || {};
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const rec = resolveOwnedListing(slug, all, hostexMap);
  if (!rec || rec.ownerSub !== owner.sub) {
    return res.status(403).json({ error: 'Not your listing' });
  }
  // NOTE: Tropicana units share one Drive folder — ranking one ranks them all.
  const folder = rec.folder;
  if (!folder) return res.status(400).json({ error: 'This listing has no photo folder yet' });
  if (!process.env.ANTHROPIC_API_KEY || !process.env.GOOGLE_API_KEY) {
    return res.status(500).json({ error: 'Photo sorting not configured' });
  }
  try {
    const result = await rankStep(folder, {
      kvGet, kvSet, kvDel,
      googleApiKey: process.env.GOOGLE_API_KEY,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      force: false,
    });
    return res.status(200).json(result);
  } catch (e) {
    await logError(process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN, 'portal-rank', e);
    return res.status(502).json({ error: 'Photo sorting failed — try again' });
  }
}

async function deleteProperty(req, res, owner, { kvGet, kvSet, kvDel }) {
  const slug = cleanStr(req.query.slug) || cleanStr(req.body?.slug);
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  if (isHostexSlug(slug)) {
    return res.status(403).json({ error: 'This listing is managed by Samba and can’t be removed from here.' });
  }
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
    // Empty submitted value → keep what the listing already has. Maya's
    // intake is told it "fills gaps"; a re-submit with only photosLink must
    // not wipe the name, price or description (Vila Lestari, 23 Aug 2026).
    name: cleanStr(data.name) || existing?.name || '',
    tag: cleanStr(data.tag || data.area) || existing?.tag || '',
    unitType: cleanStr(data.unitType) || existing?.unitType || '',
    location: /^https?:\/\//.test(location) ? location : '',
    icalUrl: /^https?:\/\//.test(cleanStr(data.icalUrl)) ? cleanStr(data.icalUrl) : (existing?.icalUrl || ''),
    // Provided → use it; omitted → keep what's stored. Lets a bad auto-picked
    // cover be corrected without the admin UI (Vila Lestari's cover was one of
    // the side-by-side collages the owner first sent).
    coverPhotoId: (/^[A-Za-z0-9_-]{10,}$/.test(cleanStr(data.coverPhotoId)) ? cleanStr(data.coverPhotoId) : '') || existing?.coverPhotoId || '',
    coverPosition: existing?.coverPosition || '50% 50%',
    mapEmbed: existing?.mapEmbed || '',
    overview: cleanStr(data.overview) || existing?.overview || '',
    features: cleanLines(data.features).length ? [...bbFeature, ...cleanLines(data.features)] : (existing?.features || bbFeature),
    // Fields below: take the submitted value when the form provided one,
    // otherwise keep whatever the listing already had (so editing through a
    // form that omits a field never silently wipes it).
    inclusions: data.inclusions !== undefined ? cleanLines(data.inclusions) : (existing?.inclusions || []),
    yearlyInclusions: data.yearlyInclusions !== undefined ? cleanLines(data.yearlyInclusions) : (existing?.yearlyInclusions || []),
    locationHighlights: data.locationHighlights !== undefined ? cleanLines(data.locationHighlights) : (existing?.locationHighlights || []),
    monthly: cleanStr(data.monthly) || existing?.monthly || '',
    yearly: cleanStr(data.yearly) || existing?.yearly || '',
    yearly2: data.yearly2 !== undefined ? cleanStr(data.yearly2) : (existing?.yearly2 || ''),
    folder: extractFolderId(data.photosLink || data.folder) || existing?.folder || '',
    // Omitted (not empty) means "leave as-is", matching the other optional
    // fields below — so a Maya intake that declines to publish a contact can
    // never silently wipe one an owner or admin had already set.
    waNumber: data.waNumber !== undefined
      ? cleanStr(data.waNumber).replace(/[^0-9]/g, '')
      : (existing?.waNumber || ''),
    waContactName: cleanStr(data.waContactName) || existing?.waContactName || '',
    // Dedicated weekly-report contact (owner) — separate from the operational
    // waNumber (often a manager). Both receive Maya's weekly report.
    reportContactName: data.reportContactName !== undefined ? cleanStr(data.reportContactName) : (existing?.reportContactName || ''),
    reportWaNumber: data.reportWaNumber !== undefined ? cleanStr(data.reportWaNumber).replace(/[^0-9]/g, '') : (existing?.reportWaNumber || ''),
    bedrooms: bed || existing?.bedrooms || undefined,
    bathrooms: bath || existing?.bathrooms || undefined,
    // Provided → use it (availability can now come in with an intake);
    // omitted → keep what the listing already had.
    bookedRanges: cleanBookedRanges(data.bookedRanges) || existing?.bookedRanges || [],
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
// Booked date ranges, sanitized the same way api/listings.js does. Lets an
// intake carry availability — a villa that isn't free until a future date must
// not show as "available now" to agents (Palem Kembar 1, free 1 Dec 2026).
const RANGE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanBookedRanges(a) {
  if (!Array.isArray(a)) return null;
  return a
    .filter(r => r && RANGE_DATE_RE.test(r.from) && RANGE_DATE_RE.test(r.to) && r.from <= r.to)
    .map(r => ({ from: r.from, to: r.to }));
}

// ── Native photo upload (wizard) ────────────────────────────────────
// The client resizes to ≤1600px JPEG before sending (base64 in JSON keeps
// the default body parser), so payloads stay well under Vercel's limit.
async function uploadPhoto(req, res) {
  if (!driveConfigured()) {
    return res.status(400).json({ error: 'Photo upload is not set up — paste a Drive folder link instead.' });
  }
  const { name, mime, data, folderId, folderName, index } = req.body || {};
  if (!data || !/^image\//.test(String(mime || ''))) return res.status(400).json({ error: 'Invalid image' });
  let bytes;
  try { bytes = Buffer.from(String(data), 'base64'); } catch { return res.status(400).json({ error: 'Bad image data' }); }
  if (bytes.length < 1000) return res.status(400).json({ error: 'Image too small' });
  if (bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — try a smaller photo' });
  let folder = cleanStr(folderId);
  if (folder && !/^[A-Za-z0-9_-]{10,}$/.test(folder)) return res.status(400).json({ error: 'Bad folder id' });
  if (!folder) folder = await createPhotoFolder(`${cleanStr(folderName) || 'Villa'} — photos`);
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const fname = `${String((Number(index) || 0) + 1).padStart(3, '0')}-${(cleanStr(name) || 'photo').replace(/[^\w.-]+/g, '_').slice(0, 60)}.${ext}`;
  const fileId = await uploadBytes({ name: fname, mime, bytes, folderId: folder });
  return res.status(200).json({ ok: true, fileId, folderId: folder, folderLink: folderLink(folder) });
}

// ── Villa-name / address search (wizard location field) ─────────────
// Google Places finds named villas ("Villa Serenity Canggu") the way owners
// expect; OpenStreetMap only knows streets. Falls back to OSM when the
// Places API isn't enabled on the key, so the field always works.
async function placeSearch(req, res) {
  const q = cleanStr(req.query.q).slice(0, 120);
  if (q.length < 3) return res.status(200).json({ results: [] });
  const key = process.env.GOOGLE_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
        },
        body: JSON.stringify({
          textQuery: q,
          locationBias: { circle: { center: { latitude: -8.65, longitude: 115.13 }, radius: 50000 } },
          pageSize: 5,
        }),
      });
      const d = await r.json();
      if (r.ok && Array.isArray(d.places) && d.places.length) {
        return res.status(200).json({
          results: d.places.map(p => ({
            name: p.displayName?.text || '',
            address: p.formattedAddress || '',
            lat: p.location?.latitude, lon: p.location?.longitude,
          })).filter(p => p.lat != null),
        });
      }
    } catch { /* fall through to OSM */ }
  }
  try {
    const qq = /bali|indonesia/i.test(q) ? q : q + ', Bali, Indonesia';
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(qq), {
      headers: { 'User-Agent': 'sambarentals.com listing wizard' },
    });
    const d = await r.json();
    return res.status(200).json({
      results: (Array.isArray(d) ? d : []).map(p => ({ name: p.display_name, address: '', lat: +p.lat, lon: +p.lon })),
    });
  } catch {
    return res.status(200).json({ results: [] });
  }
}

// ── Manual photo order (wizard drag-reorder / cover pick) ───────────
// Writes the same photo_order:{folder} record the AI ranker produces, so
// api/media.js and api/listings.js honour a manual order with no changes.
async function setPhotoOrder(req, res, owner, { kvGet, kvSet, kvDel }) {
  const folder = cleanStr(req.body?.folder);
  const ids = Array.isArray(req.body?.order)
    ? req.body.order.map(cleanStr).filter(id => /^[A-Za-z0-9_-]{5,}$/.test(id)) : [];
  if (!/^[A-Za-z0-9_-]{10,}$/.test(folder) || !ids.length) {
    return res.status(400).json({ error: 'Invalid folder or order' });
  }
  // The folder must be the owner's: attached to one of their listings, or to
  // their in-progress draft.
  const owned = (await kvGet(`owner_listings:${owner.sub}`)) || [];
  const all = (await kvGet(CUSTOM_KEY)) || {};
  const draft = await kvGet(`draft:${owner.sub}`);
  const ok = owned.some(s => all[s]?.folder === folder) || draft?.folderId === folder;
  if (!ok) return res.status(403).json({ error: 'Not your folder' });
  const existing = (await kvGet(`photo_order:${folder}`)) || {};
  // Removed photos are hidden (excluded), not deleted from Drive.
  const removed = Array.isArray(req.body?.excluded)
    ? req.body.excluded.map(cleanStr).filter(id => /^[A-Za-z0-9_-]{5,}$/.test(id)) : [];
  const excluded = [...new Set([...(existing.excluded || []), ...removed])].filter(id => !ids.includes(id));
  await kvSet(`photo_order:${folder}`, {
    ...existing,
    order: ids,
    junkStart: ids.length,
    cover: ids[0],
    excluded,
  });
  await kvDel(`autocover:${folder}`);
  return res.status(200).json({ ok: true });
}
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
  let html = (await r.text()).slice(0, 2500000);
  let finalUrl = new URL(r.url);

  // Airbnb geo-handoff: some regions get a tiny page that POSTs the visitor to
  // their local domain (www.airbnb.ca etc.) instead of a redirect. Retry the
  // same path once on the target domain.
  const handoff = html.includes('domain_switch/handoff') && html.match(/action=["']https:\/\/(www\.airbnb\.[a-z.]{2,6})\//i);
  if (handoff && IMPORT_HOSTS.test(handoff[1])) {
    try {
      const retryUrl = `https://${handoff[1]}${url.pathname}${url.search}`;
      const r2 = await fetch(retryUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (r2.ok && IMPORT_HOSTS.test(new URL(r2.url).hostname)) {
        html = (await r2.text()).slice(0, 2500000);
        finalUrl = new URL(r2.url);
      }
    } catch { /* keep the original page */ }
  }

  const fields = extractListingFields(html, finalUrl.hostname, finalUrl.pathname);
  if (!fields.name && !fields.overview && fields.bedrooms == null) {
    return res.status(422).json({ error: 'Could not read details from that page — you can still fill the form manually' });
  }
  // Photos import client-side in chunks via ?action=import-photos; the flag
  // tells the form whether that pipeline is available (Drive SA configured).
  return res.status(200).json({ fields, photosImportable: driveConfigured() && (fields.photos || []).length > 0 });
}

// Only these CDNs may be fetched by import-photos — the URL list comes from
// the client, so without this an authed user could make the server fetch
// arbitrary URLs (SSRF) or fill an owner's Drive with junk.
const PHOTO_CDN = /^https:\/\/(a0\.muscache\.com\/im\/pictures\/|cf\.bstatic\.com\/xdata\/images\/hotel\/)/;

async function importPhotos(req, res) {
  if (!driveConfigured()) {
    return res.status(503).json({ error: 'Photo import is not configured yet — add the photos with a Google Drive folder link instead' });
  }
  const body = req.body || {};
  const photos = (Array.isArray(body.photos) ? body.photos : []).filter(u => PHOTO_CDN.test(String(u))).slice(0, 20);
  if (!photos.length) return res.status(400).json({ error: 'No importable photo URLs' });
  const startIndex = Math.max(0, parseInt(body.startIndex, 10) || 0);

  let folderId = String(body.folderId || '').trim();
  if (folderId && !/^[A-Za-z0-9_-]{10,}$/.test(folderId)) return res.status(400).json({ error: 'Invalid folder id' });
  try {
    if (!folderId) {
      const name = String(body.folderName || '').replace(/[^\w\s'&.-]/g, '').trim().slice(0, 80) || 'Imported villa';
      folderId = await createPhotoFolder(`${name} — photos`);
    }
  } catch (e) {
    console.error('import-photos folder create failed:', e.message);
    return res.status(502).json({ error: 'Could not create the Drive folder: ' + e.message });
  }

  // A few at a time, in parallel; one bad photo never fails the chunk. The
  // first failure's message is surfaced so systemic errors (quota, auth) are
  // diagnosable from the client instead of buried in function logs.
  let firstError = null;
  const results = await Promise.all(photos.map((url, i) =>
    uploadPhotoFromUrl({ url, folderId, index: startIndex + i })
      .then(() => true)
      .catch((e) => { if (!firstError) firstError = e.message; console.warn('photo import failed:', e.message); return false; })
  ));
  const uploaded = results.filter(Boolean).length;
  return res.status(200).json({ ok: true, folderId, folderLink: folderLink(folderId), uploaded, failed: photos.length - uploaded, ...(firstError ? { firstError } : {}) });
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

// ── Listing photo extraction ─────────────────────────────────────────
// Airbnb pages carry the gallery as a0.muscache.com/im/pictures/… URLs (raw or
// /-escaped JSON). Detail pages ALSO embed "similar listings" photos, so
// when the /rooms/{id} id is known we keep only paths tagged with this
// listing's id — it appears numerically ("Hosting-123…") or as base64 of
// "StaySupplyListing:{id}" (the two encodings duplicate the same gallery, so
// results dedupe by the photo's uuid filename). Booking.com ships
// cf.bstatic.com/xdata/images/hotel/{size}/{id}.jpg — size segment normalized
// to a large variant. Order = document order, which tracks gallery order.
function extractPhotos(html, host, pathname) {
  const photos = [];
  const seen = new Set();
  const push = (u) => {
    const clean = u.split('?')[0];
    const fname = clean.split('/').pop();
    if (!fname || seen.has(fname)) return;
    seen.add(fname);
    photos.push(clean);
  };
  if (/airbnb/i.test(host)) {
    const text = html.replace(/\\u002F/gi, '/');
    const all = text.match(/https:\/\/a0\.muscache\.com\/im\/pictures\/[^"'\\\s)]+/g) || [];
    const junk = /AirbnbPlatformAssets|\/im\/pictures\/user\/|\/user\//i;
    const candidates = all.filter(u => !junk.test(u));
    const id = (String(pathname || '').match(/\/rooms\/(\d+)/) || [])[1];
    let own = candidates;
    if (id) {
      const b64 = Buffer.from(`StaySupplyListing:${id}`).toString('base64');
      const mine = candidates.filter(u =>
        u.includes(`-${id}/`) || u.includes(b64) || u.includes(encodeURIComponent(b64)));
      // A confident id-match wins; very old listings tag photos differently,
      // so with too few matches fall back to everything non-junk.
      if (mine.length >= 3) own = mine;
    }
    own.forEach(push);
  } else {
    const all = html.match(/https:\/\/cf\.bstatic\.com\/xdata\/images\/hotel\/[^"'\\\s)]+/g) || [];
    all.map(u => u.replace(/\/xdata\/images\/hotel\/[^/]+\//, '/xdata/images/hotel/max1024x768/')).forEach(push);
  }
  return photos.slice(0, 20);
}

// Curated amenity extraction — Airbnb embeds structured amenity entries as
// {"available":true,"title":"…"}. Raw titles are noisy (Shampoo, Hangers,
// smoke alarms…), so only villa-level selling points mapped to our own
// vocabulary survive. First matching rule wins; labels dedupe.
const AMENITY_MAP = [
  [/private pool/i, 'features', 'Private pool'],
  [/shared pool/i, 'features', 'Shared pool'],
  [/^pool$/i, 'features', 'Private pool'],
  [/air conditioning/i, 'features', 'Air conditioning'],
  [/kitchen(?!ette)/i, 'features', 'Full kitchen'],
  [/kitchenette/i, 'features', 'Kitchenette'],
  [/workspace/i, 'features', 'Dedicated workspace'],
  [/bathtub/i, 'features', 'Bathtub'],
  [/free parking|parking garage|carport/i, 'features', 'Free parking'],
  [/washer/i, 'features', 'Washer'],
  [/wifi/i, 'features', 'Fast wifi'],
  [/backyard|garden(?! view)/i, 'features', 'Garden'],
  [/rooftop/i, 'features', 'Rooftop'],
  [/balcony|patio/i, 'features', 'Balcony'],
  [/bbq|barbecue/i, 'features', 'BBQ'],
  [/gym|exercise equipment/i, 'features', 'Gym access'],
  [/pets allowed/i, 'features', 'Pet friendly'],
  [/beach access|beachfront/i, 'highlights', 'Beach access'],
  [/sea view|ocean view/i, 'highlights', 'Ocean view'],
  [/mountain view/i, 'highlights', 'Mountain view'],
  [/rice ?(paddy|field)/i, 'highlights', 'Rice-field views'],
];
function extractAmenities(html) {
  const features = [], highlights = [], seen = new Set();
  for (const m of html.matchAll(/"available":true,"title":"([^"]{2,60})"/g)) {
    const title = decodeEntities(m[1]);
    for (const [re, kind, label] of AMENITY_MAP) {
      if (re.test(title)) {
        if (!seen.has(label)) { seen.add(label); (kind === 'features' ? features : highlights).push(label); }
        break;
      }
    }
  }
  return { features: features.slice(0, 8), highlights: highlights.slice(0, 3) };
}

function extractListingFields(html, host, pathname) {
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

  // Curated amenities → feature/highlight suggestions (Airbnb only in
  // practice; the patterns simply don't match on Booking pages).
  const am = extractAmenities(html);
  if (am.features.length) out.features = am.features;
  if (am.highlights.length) out.locationHighlights = am.highlights;

  // Gallery photos — the cover (og:image) is promoted to the front when it's
  // one of the gallery shots.
  const photos = extractPhotos(html, host, pathname);
  if (photos.length) {
    const ogF = (metaContent(html, 'og:image').split('?')[0] || '').split('/').pop();
    const i = ogF ? photos.findIndex(p => p.split('/').pop() === ogF) : -1;
    if (i > 0) photos.unshift(photos.splice(i, 1)[0]);
    out.photos = photos;
  }

  out.source = /airbnb/i.test(host) ? 'airbnb' : 'booking';
  return out;
}

// Exported for the dev test harness (pure function, no I/O).
export { extractListingFields };
