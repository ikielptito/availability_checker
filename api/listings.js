const HAUS = {
  tag: 'Batu Bolong · Canggu',
  location: 'https://maps.app.goo.gl/tMuPXqKHxhbKLDVe6',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1429!3d-8.6419!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzgnMzEuMCJTIDExNcKwMDgnMzQuNiJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Boutique collection of 8 fully furnished one-bedroom apartments in the heart of Batu Bolong. Steps from cafés, restaurants, and nightlife, yet tucked in a quiet residential lane.',
  features: ['43–46m² building · 4 are land', '1 Bedroom · 1 Bathroom', 'Large shared swimming pool', 'Outdoor lounge seating', 'Terrazzo bathrooms · Teak & rattan cabinetry', 'Fully equipped kitchen · Air-conditioning', 'High-speed fiber internet · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Electricity', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly'],
  yearlyInclusions: ['Villa only, no services included.'],
  locationHighlights: ['2-min walk to Bali Social Club', '5-min walk to Batu Bolong strip', '10-min ride to Batu Bolong Beach', '5-min drive to Pererenan'],
};
const LANE = {
  tag: 'Pererenan',
  location: 'https://maps.app.goo.gl/JGcqfdZMqUXSVjpD9',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1348!3d-8.6283!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzcnNDIuMCJTIDExNcKwMDgnMDMuMyJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Boutique collection of 3 fully furnished one-bedroom townhouses in central Pererenan. Walkable yet private, ideal for long-term living.',
  features: ['250m² land', '1 Bedroom · 1 Bathroom', 'Large shared swimming pool', 'XL king beds · Dedicated workspaces', 'Terrazzo floors & bathrooms', 'Fully equipped kitchen · Air-conditioning', '200mbps fiber (dedicated per unit) · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly', 'Electricity excluded for yearly'],
  yearlyInclusions: ['Villa only, no services included.'],
  locationHighlights: ['1-min to Pepito & Frestive', '3-min to Obsidian Gym', '4-min to Bar Vera', '8-min to Pererenan Beach', '10-min to La Brisa'],
};
const SATURNO = {
  tag: 'Padang Linjong · Canggu',
  location: 'https://maps.app.goo.gl/r4833cRt8oEXMjpD9',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1353!3d-8.6469!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzgnNDkuNiJTIDExNcKwMDgnMDcuMyJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Spacious 3-bedroom villa in prime Padang Linjong next to Bali Buddha. Central, walkable, and ideal for long-term living.',
  features: ['350m² land · 250m² building', '3 Bedrooms · 3 Bathrooms', 'Private swimming pool · Tropical garden', 'Enclosed AC living · Open-concept kitchen', 'Washing machine · Surfboards · Tennis rackets', 'Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly'],
  yearlyInclusions: ['Villa only, no services included.'],
  locationHighlights: ['Next to Bali Buddha', 'Walking distance to shops & cafés', 'Central Canggu location'],
};
const TROPICANA = {
  tag: 'Buduk · Near Canggu',
  location: 'https://maps.app.goo.gl/T78azqdxnspQAnVs5',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1549!3d-8.6153!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzYnNTUuMSJTIDExNcKwMDknMTcuNiJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Modern private residences in Buduk offering private outdoor space, quiet surroundings, and proximity to Pererenan and Canggu.',
  features: ['60m² land · 75m² building', '1 Bedroom · 1 Bathroom', 'Private swimming pool & poolside seating', 'Balcony with bistro table · Dedicated workspace', 'Extra-large two-person wardrobe', 'Fully equipped kitchen · Air-conditioning', 'High-speed fiber internet · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly', 'Electricity excluded for yearly'],
  yearlyInclusions: ['Villa only, no services included.'],
  locationHighlights: ['5-min to Pererenan', '10-min to Canggu', 'Quiet residential area'],
};

// Per-unit identity/price/folder comes from the shared canonical catalog
// (lib/catalog.js) so it can't drift from api/digest.js / api/check-availability.js.
// The building-level constants above (tag, location, map, overview, features,
// inclusions…) are the portal's presentation layer and stay here.
import { UNITS } from '../lib/catalog.js';
import { rankStep } from '../lib/photorank.js';
import { sanitizePublicListing } from '../lib/owner-listings.js';
import { driveConfigured, uploadBytes } from '../lib/drive-photos.js';
const BUILDING = {
  'haus-1': HAUS, 'haus-2': HAUS, 'haus-4': HAUS, 'haus-5': HAUS,
  'lanehaus-1': LANE, 'lanehaus-3': LANE,
  'villa-saturno': SATURNO,
  'tropicana-a4': TROPICANA, 'tropicana-a5': TROPICANA, 'tropicana-b2': TROPICANA,
  'tropicana-b3': TROPICANA, 'tropicana-b4': TROPICANA, 'tropicana-b5': TROPICANA, 'tropicana-b6': TROPICANA,
};
const DEFAULTS = Object.fromEntries(UNITS.map(u => [u.slug, {
  ...BUILDING[u.slug], slug: u.slug, unitType: u.unitType, hostexId: u.hostexId,
  name: u.name, monthly: u.monthly, yearly: u.yearly, yearly2: u.yearly2, folder: u.folder,
}]));

const CUSTOM_KEY = 'custom_properties';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Public visibility for a custom listing. Admin-curated listings (no ownerSub)
// are visible unless hidden. Owner-submitted listings go public once approved.
// Card billing is offline, so approval alone makes an owner listing live — the
// subscription paywall is intentionally NOT enforced here for now. (comped is
// still honoured so pre-comped listings behave the same.)
// Exported: api/digest.js applies the same rule so Maya/CRM consumers never
// see a listing the public feed would hide (e.g. pending_review intakes).
export function listingVisible(c) {
  if (c.hidden) return false;
  // Pure admin-curated listing with no owner assigned: always public. A listing
  // linked to an owner by Google sub, email, OR WhatsApp number (Maya intake)
  // is NOT admin-curated and must pass the review gate below.
  if (!c.ownerSub && !c.ownerEmail && !c.ownerWa) return true;
  // Comped listings are always public; otherwise the listing must be approved.
  if (c.comped) return true;
  return c.status === 'approved';
}

function cleanStr(v) { return typeof v === 'string' ? v.trim() : ''; }
// Cover focal point as "X% Y%" (0–100 each). Falls back to centered.
function cleanPos(v) { const s = cleanStr(v); return /^\d{1,3}% \d{1,3}%$/.test(s) ? s : '50% 50%'; }
function cleanLines(a) { return Array.isArray(a) ? a.map(s => String(s).trim()).filter(Boolean) : []; }
function cleanRanges(a) {
  if (!Array.isArray(a)) return [];
  return a
    .filter(r => r && DATE_RE.test(r.from) && DATE_RE.test(r.to) && r.from <= r.to)
    .map(r => ({ from: r.from, to: r.to }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const json = await r.json();
    if (!json.result) return null;
    try { return JSON.parse(json.result); } catch { return null; }
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  }

  async function kvDel(key) {
    await fetch(`${kvUrl}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}` }
    });
  }

  // Derive a listing's cover photo from its Google Drive folder (first image
  // by name) when no coverPhotoId was set in admin. Cached in KV so the Drive
  // API is hit once per folder. Guarantees share previews show a real villa
  // photo rather than the generic portal card. Owner edits clear this cache
  // (see api/portal.js saveProperty) so newly added photos are picked up.
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  async function deriveCover(folder) {
    if (!folder) return '';
    const cached = await kvGet(`autocover:${folder}`);
    if (typeof cached === 'string') return cached;
    // Prefer the AI-picked hero shot (written by dev/photo-rank.mjs) over the
    // filename-sort heuristic. Manual coverPhotoId still wins upstream in
    // fillCovers, which only calls this when no cover was set.
    const ranked = await kvGet(`photo_order:${folder}`);
    if (ranked?.cover) {
      await kvSet(`autocover:${folder}`, ranked.cover);
      return ranked.cover;
    }
    if (!GOOGLE_API_KEY) return '';
    try {
      const url = `https://www.googleapis.com/drive/v3/files?q='${folder}'+in+parents+and+mimeType+contains+'image/'&fields=files(id,name)&key=${GOOGLE_API_KEY}&pageSize=150`;
      const data = await (await fetch(url)).json();
      // A hidden photo must never come back as the cover — hiding the ROI chart
      // only to have the filename sort re-pick it would undo the whole point.
      const skip = new Set(ranked?.excluded || []);
      const files = (data.files || []).filter(f => !skip.has(f.id))
        .slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      const id = files.length ? files[0].id : '';
      await kvSet(`autocover:${folder}`, id);
      return id;
    } catch { return ''; }
  }
  async function fillCovers(arr) {
    await Promise.all(arr.map(async (l) => {
      if (!l.coverPhotoId && l.folder) { const id = await deriveCover(l.folder); if (id) l.coverPhotoId = id; }
    }));
  }

  function checkAuth() {
    const adminPw = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD;
    if (!adminPw) return true;
    const auth = req.headers.authorization || '';
    return auth === `Bearer ${adminPw}`;
  }

  // Push the changed listing to the CRM so Maya's `rentals` table stays in sync.
  // Fire-and-forget but awaited (serverless may freeze after the response):
  // failures here must never block the listing save.
  async function notifyCrmSync(slug, action) {
    const url = process.env.CRM_SYNC_URL;          // e.g. https://kaya-agent-crm.vercel.app/api/sync-rental
    const secret = process.env.LISTING_SYNC_SECRET;
    if (!url || !secret) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ slug, action }),
      });
    } catch (e) { /* CRM sync is best-effort */ }
  }

  if (req.method === 'GET') {
    // Admin: list promo codes (with redemption counts) for the console.
    if (req.query.promos === '1') {
      if (!checkAuth()) return res.status(401).json({ error: 'Unauthorized' });
      const promos = (await kvGet('promo_codes')) || {};
      return res.status(200).json({ promos });
    }
    const slugs = Object.keys(DEFAULTS);
    const [customMap, ...kvResults] = await Promise.all([
      kvGet(CUSTOM_KEY),
      ...slugs.map(s => kvGet(`listing:${s}`)),
    ]);
    const listings = slugs.map((slug, i) => ({
      ...DEFAULTS[slug],
      ...(kvResults[i] || {}),
    }));
    const customAll = Object.values(customMap || {});

    // Admin view (?all=1, authenticated): every custom listing incl. drafts.
    if (req.query.all === '1' && checkAuth()) {
      const customListings = customAll.map(c => ({ ...c, custom: true }));
      const out = [...listings, ...customListings];
      await fillCovers(out);
      return res.status(200).json({ listings: out });
    }

    // Public view: admin-curated listings, plus owner listings that have been
    // approved (billing gate is currently off — approval alone makes them live).
    // Every row is sanitized: owner identity fields (ownerSub/ownerEmail/…)
    // live on both custom records and Hostex overrides now, and must never be
    // served unauthenticated. waNumber/waContactName stay — public enquiry
    // flow reads them.
    const customListings = customAll
      .filter(c => listingVisible(c))
      .map(c => sanitizePublicListing({ ...c, custom: true }));
    const out = [...listings.map(sanitizePublicListing), ...customListings];
    await fillCovers(out);
    return res.status(200).json({ listings: out });
  }

  if (req.method === 'DELETE') {
    if (!checkAuth()) return res.status(401).json({ error: 'Unauthorized' });
    const slug = req.query.slug;
    if (!slug) return res.status(400).json({ error: 'Missing slug' });
    const all = await kvGet(CUSTOM_KEY) || {};
    if (!all[slug]) return res.status(404).json({ error: 'Not found' });
    delete all[slug];
    await kvSet(CUSTOM_KEY, all);
    await notifyCrmSync(slug, 'delete');
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST') {
    // Key-facts merge (deposit, electricity, wifi, pool, minStay, petFriendly):
    // Maya applies a villa contact's chase answer straight to the listing.
    // Merge-only — no other field is readable or writable through this path,
    // so the CRM can never clobber a listing. Accepts the CRM's sync secret
    // (the same one the sync webhook uses) as well as the admin password.
    if (req.body?.action === 'update-facts') {
      const sync = process.env.LISTING_SYNC_SECRET;
      const authed = checkAuth() || (sync && (req.headers.authorization || '') === `Bearer ${sync}`);
      if (!authed) return res.status(401).json({ error: 'Unauthorized' });
      const slug = String(req.body.slug || '');
      const facts = req.body.facts || {};
      const patch = {};
      for (const f of ['deposit', 'electricity', 'wifi', 'pool', 'minStay']) {
        if (typeof facts[f] === 'string' && facts[f].trim()) patch[f] = facts[f].trim().slice(0, 120);
      }
      if (typeof facts.petFriendly === 'boolean') patch.petFriendly = facts.petFriendly;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'No facts to apply' });
      let hidden = false;
      if (DEFAULTS[slug]) {
        const override = await kvGet(`listing:${slug}`) || { slug };
        Object.assign(override, patch);
        override.updatedAt = Date.now();
        await kvSet(`listing:${slug}`, override);
        hidden = !!override.hidden;
      } else {
        const all = await kvGet(CUSTOM_KEY) || {};
        if (!all[slug]) return res.status(404).json({ error: 'Not found' });
        Object.assign(all[slug], patch);
        all[slug].updatedAt = Date.now();
        await kvSet(CUSTOM_KEY, all);
        hidden = !!all[slug].hidden;
      }
      await notifyCrmSync(slug, hidden ? 'delete' : 'upsert');
      return res.status(200).json({ ok: true, slug, applied: Object.keys(patch) });
    }

    if (!checkAuth()) return res.status(401).json({ error: 'Unauthorized' });

    // Promo codes: create/update or delete (free-month activation codes used by
    // the owner checkout while card billing is offline). Stored in `promo_codes`,
    // the same store api/portal.js redeemPromo validates against.
    if (req.body?.action === 'promo-save') {
      const code = String(req.body.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{3,24}$/.test(code)) return res.status(400).json({ error: 'Code must be 3–24 letters or numbers.' });
      const promos = (await kvGet('promo_codes')) || {};
      const ex = promos[code] || { redemptions: 0 };
      const durationDays = Math.max(1, parseInt(req.body.durationDays, 10) || ex.durationDays || 30);
      const active = req.body.active !== false;
      let maxR = req.body.maxRedemptions;
      maxR = (maxR === '' || maxR == null) ? null : (Math.max(1, parseInt(maxR, 10) || 0) || null);
      promos[code] = { type: 'free_month', durationDays, active, maxRedemptions: maxR, redemptions: ex.redemptions || 0, redeemedBy: ex.redeemedBy || [], updatedAt: Date.now() };
      await kvSet('promo_codes', promos);
      return res.status(200).json({ ok: true, promos });
    }
    if (req.body?.action === 'promo-delete') {
      const code = String(req.body.code || '').trim().toUpperCase();
      const promos = (await kvGet('promo_codes')) || {};
      delete promos[code];
      await kvSet('promo_codes', promos);
      return res.status(200).json({ ok: true, promos });
    }

    // AI photo sort: one scoring step per call (serverless time limits) —
    // the admin UI keeps calling until { status: 'done' }. Logic shared with
    // dev/photo-rank.mjs via lib/photorank.js.
    if (req.body?.action === 'rank') {
      const folder = cleanStr(req.body.folder);
      if (!/^[A-Za-z0-9_-]{10,}$/.test(folder)) return res.status(400).json({ error: 'Invalid folder id' });
      if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
      try {
        const result = await rankStep(folder, {
          kvGet, kvSet, kvDel,
          googleApiKey: GOOGLE_API_KEY,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY,
          force: !!req.body.force,
        });
        return res.status(200).json(result);
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }

    // Save a manual photo order for a folder. Writes the same
    // photo_order:{folder} record the AI ranker and the owner wizard produce,
    // so api/media.js and deriveCover honour it with no changes. `excluded`
    // is carried over untouched — reordering must never un-hide a photo.
    if (req.body?.action === 'set-photo-order') {
      const folder = cleanStr(req.body.folder);
      const ids = Array.isArray(req.body.order)
        ? req.body.order.map(cleanStr).filter(id => /^[A-Za-z0-9_-]{5,}$/.test(id)) : [];
      if (!/^[A-Za-z0-9_-]{10,}$/.test(folder)) return res.status(400).json({ error: 'Invalid folder id' });
      if (!ids.length) return res.status(400).json({ error: 'No photo order given' });
      const existing = (await kvGet(`photo_order:${folder}`)) || {};
      const excluded = (existing.excluded || []).filter(id => !ids.includes(id));
      await kvSet(`photo_order:${folder}`, {
        ...existing,
        order: ids,
        junkStart: ids.length,     // a hand-picked order has no junk tail
        cover: existing.cover && ids.includes(existing.cover) ? existing.cover : ids[0],
        excluded,
        manual: true,
      });
      await kvDel(`autocover:${folder}`);
      return res.status(200).json({ ok: true, count: ids.length });
    }

    // Upload one photo straight into a listing's Drive folder, so photos can be
    // added from the admin page instead of going to Drive to do it. One photo
    // per request: the serverless body cap is ~4.5MB and base64 inflates by a
    // third, so the client downscales and posts them one at a time.
    if (req.body?.action === 'upload-photo') {
      const folder = cleanStr(req.body.folder);
      const name = cleanStr(req.body.name).replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'photo.jpg';
      const mime = cleanStr(req.body.mime) || 'image/jpeg';
      const b64 = typeof req.body.data === 'string' ? req.body.data : '';
      if (!/^[A-Za-z0-9_-]{10,}$/.test(folder)) return res.status(400).json({ error: 'Invalid folder id' });
      if (!/^image\/(jpeg|jpg|png|webp|gif|heic|heif)$/i.test(mime)) return res.status(400).json({ error: 'Only image files can be uploaded' });
      if (!b64) return res.status(400).json({ error: 'No image data' });
      if (!driveConfigured()) return res.status(500).json({ error: 'Google Drive is not configured on the server' });
      let bytes;
      try { bytes = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ error: 'Bad image data' }); }
      if (!bytes.length) return res.status(400).json({ error: 'Empty image' });
      if (bytes.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'Image too large — keep it under 12MB' });
      try {
        const id = await uploadBytes({ name, mime, bytes, folderId: folder });
        // A new photo may deserve to be the cover, and the gallery caches the
        // derived one — drop it so the folder is looked at fresh.
        await kvDel(`autocover:${folder}`);
        return res.status(200).json({ ok: true, id, name });
      } catch (e) {
        return res.status(502).json({ error: e.message || 'Upload failed' });
      }
    }

    // Toggle a single photo's visibility on the live gallery (admin restore of
    // an AI-hidden duplicate, or a manual hide). Edits photo_order.excluded;
    // never touches Google Drive. No-op if there's no ranked order yet.
    if (req.body?.action === 'set-photo-hidden') {
      const folder = cleanStr(req.body.folder);
      const photoId = cleanStr(req.body.photoId);
      const hidden = !!req.body.hidden;
      if (!/^[A-Za-z0-9_-]{10,}$/.test(folder) || !/^[A-Za-z0-9_-]{5,}$/.test(photoId)) {
        return res.status(400).json({ error: 'Invalid folder or photo id' });
      }
      // Hiding must work on ANY folder, not only one the AI has already ranked.
      // Otherwise a stray shot in an otherwise good folder (the ROI chart in
      // Palem Kembar's renderings) can only be removed by deleting it from
      // Google Drive, which is exactly what we don't want. With no ranked order
      // yet, start an empty record: `excluded` alone is enough for
      // api/media.js to drop the photo, and an empty `order` leaves every other
      // photo in its natural Drive order. Ikiel, 24 Aug 2026.
      const order = (await kvGet(`photo_order:${folder}`))
        || { order: [], excluded: [], cover: '', junkStart: 0 };
      const excluded = new Set(order.excluded || []);
      if (hidden) excluded.add(photoId); else excluded.delete(photoId);
      order.excluded = [...excluded];
      // A restored photo must re-enter the visible order; a manually hidden one
      // must leave it. Cheapest correct fix: drop it from `order` if hiding, and
      // if restoring, append it just before the junk tail so it shows again.
      order.order = (order.order || []).filter(id => id !== photoId);
      if (!hidden) {
        const js = Number.isInteger(order.junkStart) ? order.junkStart : order.order.length;
        order.order.splice(js, 0, photoId);
        order.junkStart = js + 1;
      } else if (Number.isInteger(order.junkStart) && order.junkStart > order.order.length) {
        order.junkStart = order.order.length;
      }
      if (order.cover === photoId && hidden) order.cover = order.order[0] || '';
      await kvSet(`photo_order:${folder}`, order);
      await kvDel(`autocover:${folder}`);
      return res.status(200).json({ ok: true, excluded: order.excluded.length });
    }

    // Review action: approve / reject an owner-submitted listing.
    if (req.body?.action === 'set-status') {
      const { slug, status } = req.body;
      if (!['approved', 'rejected', 'pending_review'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const all = await kvGet(CUSTOM_KEY) || {};
      if (!all[slug]) return res.status(404).json({ error: 'Not found' });
      all[slug].status = status;
      all[slug].updatedAt = Date.now();
      await kvSet(CUSTOM_KEY, all);
      // Sync CRM: approval makes it eligible to go live (once subscribed); a
      // rejection pulls it out. Visibility is still gated by subscription.
      await notifyCrmSync(slug, status === 'approved' ? 'upsert' : 'delete');
      return res.status(200).json({ ok: true, slug, status });
    }

    // Pre-assign an existing listing to an owner by email. When that person
    // signs in with the matching Google email, the portal claims it (sets
    // ownerSub). `comped` keeps it publicly visible for free. ownerSub is NOT
    // set here — it is filled in on first sign-in.
    if (req.body?.action === 'assign-owner') {
      const { slug, ownerEmail, comped } = req.body;
      // Hostex catalog units: ownership lives in the per-slug override.
      // `comped`/`status` are meaningless here — these units are always
      // public and never billed, and must NOT be routed through
      // listingVisible(). Clearing the email also clears the claimed sub.
      if (DEFAULTS[slug]) {
        const override = await kvGet(`listing:${slug}`) || { slug };
        override.ownerEmail = ownerEmail ? String(ownerEmail).trim().toLowerCase() : null;
        if (!override.ownerEmail) override.ownerSub = null;
        override.updatedAt = Date.now();
        await kvSet(`listing:${slug}`, override);
        return res.status(200).json({ ok: true, slug, ownerEmail: override.ownerEmail, hostex: true });
      }
      const all = await kvGet(CUSTOM_KEY) || {};
      if (!all[slug]) return res.status(404).json({ error: 'Not found' });
      all[slug].ownerEmail = ownerEmail ? String(ownerEmail).trim().toLowerCase() : null;
      all[slug].comped = !!comped;
      if (!all[slug].status) all[slug].status = 'approved';
      all[slug].updatedAt = Date.now();
      await kvSet(CUSTOM_KEY, all);
      return res.status(200).json({ ok: true, slug, ownerEmail: all[slug].ownerEmail, comped: all[slug].comped, status: all[slug].status });
    }

    const { slug, data, custom } = req.body || {};
    if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });

    if (custom) {
      if (DEFAULTS[slug]) return res.status(400).json({ error: 'Slug conflicts with a Hostex listing' });
      if (!data || !cleanStr(data.name)) return res.status(400).json({ error: 'Name is required' });
      const all = await kvGet(CUSTOM_KEY) || {};
      const existing = all[slug] || {};
      all[slug] = {
        slug,
        custom: true,
        name: cleanStr(data.name),
        tag: cleanStr(data.tag),
        unitType: cleanStr(data.unitType),
        location: cleanStr(data.location),
        icalUrl: /^https?:\/\//.test(cleanStr(data.icalUrl)) ? cleanStr(data.icalUrl) : '',
        coverPhotoId: /^[A-Za-z0-9_-]{0,80}$/.test(cleanStr(data.coverPhotoId)) ? cleanStr(data.coverPhotoId) : '',
        coverPosition: cleanPos(data.coverPosition),
        mapEmbed: cleanStr(data.mapEmbed) || existing.mapEmbed || '',
        overview: cleanStr(data.overview),
        features: cleanLines(data.features),
        inclusions: cleanLines(data.inclusions),
        yearlyInclusions: cleanLines(data.yearlyInclusions),
        locationHighlights: cleanLines(data.locationHighlights),
        monthly: cleanStr(data.monthly),
        yearly: cleanStr(data.yearly),
        yearly2: cleanStr(data.yearly2),
        badge: cleanStr(data.badge).slice(0, 24),
        folder: cleanStr(data.folder),
        waNumber: cleanStr(data.waNumber).replace(/[^0-9]/g, ''),
        waContactName: cleanStr(data.waContactName),
        // Dedicated weekly-report contact (usually the owner when waNumber is
        // a manager). Maya's weekly report goes to BOTH numbers when they differ.
        reportContactName: cleanStr(data.reportContactName),
        reportWaNumber: cleanStr(data.reportWaNumber).replace(/[^0-9]/g, ''),
        bookedRanges: Array.isArray(data.bookedRanges) ? cleanRanges(data.bookedRanges) : existing.bookedRanges || [],
        hidden: !!data.hidden,
        petFriendly: !!data.petFriendly,
        // Key facts agents ask for most (deposit, electricity terms, wifi,
        // pool type, minimum stay). Free text, short; Maya quotes them
        // verbatim and chases the listed contact for the empty ones.
        deposit: cleanStr(data.deposit),
        electricity: cleanStr(data.electricity),
        wifi: cleanStr(data.wifi),
        pool: cleanStr(data.pool),
        minStay: cleanStr(data.minStay),
        // Ownership/review fields are owned by the portal + review flow; never
        // clobbered by an admin content edit.
        ownerSub: existing.ownerSub || null,
        ownerEmail: existing.ownerEmail || null,
        comped: !!existing.comped,
        status: existing.status || undefined,
        createdAt: existing.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      await kvSet(CUSTOM_KEY, all);
      // A hidden listing drops out of the live set -> deactivate its rental.
      await notifyCrmSync(slug, all[slug].hidden ? 'delete' : 'upsert');
      return res.status(200).json({ ok: true, slug });
    }

    if (!DEFAULTS[slug]) return res.status(400).json({ error: 'Unknown listing slug' });

    const existing = await kvGet(`listing:${slug}`) || {};
    const safe = {
      slug,
      hostexId: existing.hostexId || DEFAULTS[slug].hostexId,
      name: typeof data.name === 'string' ? data.name.trim() : DEFAULTS[slug].name,
      folder: typeof data.folder === 'string' ? data.folder.trim() : existing.folder || DEFAULTS[slug].folder,
      overview: typeof data.overview === 'string' ? data.overview.trim() : existing.overview || DEFAULTS[slug].overview,
      features: Array.isArray(data.features) ? data.features.map(s => String(s).trim()).filter(Boolean) : existing.features || DEFAULTS[slug].features,
      inclusions: Array.isArray(data.inclusions) ? data.inclusions.map(s => String(s).trim()).filter(Boolean) : existing.inclusions || DEFAULTS[slug].inclusions,
      yearlyInclusions: Array.isArray(data.yearlyInclusions) ? data.yearlyInclusions.map(s => String(s).trim()).filter(Boolean) : existing.yearlyInclusions || DEFAULTS[slug].yearlyInclusions,
      locationHighlights: Array.isArray(data.locationHighlights) ? data.locationHighlights.map(s => String(s).trim()).filter(Boolean) : existing.locationHighlights || DEFAULTS[slug].locationHighlights,
      monthly: typeof data.monthly === 'string' ? data.monthly.trim() : existing.monthly || DEFAULTS[slug].monthly,
      yearly: typeof data.yearly === 'string' ? data.yearly.trim() : existing.yearly || DEFAULTS[slug].yearly,
      yearly2: typeof data.yearly2 === 'string' ? data.yearly2.trim() : existing.yearly2 ?? DEFAULTS[slug].yearly2,
      // Manual marketing badge ("Price drop", "New") — shown on the portal card
      // and synced to Maya's CRM so her messages can lead with it.
      badge: typeof data.badge === 'string' ? data.badge.trim().slice(0, 24) : existing.badge || '',
      tag: typeof data.tag === 'string' ? data.tag.trim() : existing.tag || DEFAULTS[slug].tag,
      location: typeof data.location === 'string' ? data.location.trim() : existing.location || DEFAULTS[slug].location,
      mapEmbed: typeof data.mapEmbed === 'string' ? data.mapEmbed.trim() : existing.mapEmbed || DEFAULTS[slug].mapEmbed,
      waNumber: typeof data.waNumber === 'string' ? data.waNumber.replace(/[^0-9]/g, '') : existing.waNumber || '',
      waContactName: typeof data.waContactName === 'string' ? data.waContactName.trim() : existing.waContactName || '',
      // Dedicated weekly-report contact — see the custom branch above.
      reportContactName: typeof data.reportContactName === 'string' ? data.reportContactName.trim() : existing.reportContactName || '',
      reportWaNumber: typeof data.reportWaNumber === 'string' ? data.reportWaNumber.replace(/[^0-9]/g, '') : existing.reportWaNumber || '',
      // Ownership fields are set by assign-owner + the portal claim flow —
      // carried over verbatim so an admin content edit can never wipe them
      // (this rebuild replaces the whole override).
      ownerSub: existing.ownerSub || null,
      ownerEmail: existing.ownerEmail || null,
      unitType: (typeof data.unitType === 'string' && data.unitType.trim()) || existing.unitType || DEFAULTS[slug].unitType || '',
      coverPhotoId: typeof data.coverPhotoId === 'string' && /^[A-Za-z0-9_-]{0,80}$/.test(data.coverPhotoId.trim())
        ? data.coverPhotoId.trim() : existing.coverPhotoId || '',
      coverPosition: data.coverPosition !== undefined ? cleanPos(data.coverPosition) : (existing.coverPosition || '50% 50%'),
      petFriendly: typeof data.petFriendly === 'boolean' ? data.petFriendly : (existing.petFriendly ?? false),
      deposit: typeof data.deposit === 'string' ? data.deposit.trim() : existing.deposit || '',
      electricity: typeof data.electricity === 'string' ? data.electricity.trim() : existing.electricity || '',
      wifi: typeof data.wifi === 'string' ? data.wifi.trim() : existing.wifi || '',
      pool: typeof data.pool === 'string' ? data.pool.trim() : existing.pool || '',
      minStay: typeof data.minStay === 'string' ? data.minStay.trim() : existing.minStay || '',
    };

    await kvSet(`listing:${slug}`, safe);
    await notifyCrmSync(slug, 'upsert');
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
