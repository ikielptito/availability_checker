// Availability digest for downstream consumers (CRM cron, future integrations).
// Authoritative source for "what's available across the Samba portfolio."
//
// Pulls Hostex booked dates per property + custom property bookedRanges, then
// computes:
//   - availableToday: free right now
//   - nextAvailableFrom: first non-booked day from today
//   - nextLongWindowFrom: first day of a run of >=LONG_WINDOW_DAYS consecutive
//     free days within the horizon (the metric the CRM uses to decide "newly
//     bookable for a long-term rental")
//   - longWindowDays: length of that open run
//
// Cached in KV for 30 minutes so the upstream Hostex burden is bounded even
// if multiple consumers ping us.

const HORIZON_DAYS = 180;
const LONG_WINDOW_DAYS = 30;
const CACHE_TTL_MS = 30 * 60 * 1000;
const PORTAL_BASE = 'https://sambarentals.com';
const DEFAULT_WA_CONTACT = 'Era';
const DEFAULT_WA_NUMBER = '6281246357778';

// Resolve the "enquire with" pair for a listing. A listing with no contact at
// all falls back to Era (our manager). A listing that HAS a number but no name
// keeps that number and gets a neutral label — it must never be labelled "Era":
// Maya reads "Era" as "our team manages this", so an owner-listed villa with a
// bare number (Casa Suhana, 16 Aug 2026) was treated as Samba-managed and
// Era was told to arrange its viewings.
function resolveContact(name, number) {
  const num = normalizeWaNumber(number);
  if (!num) return { waContactName: DEFAULT_WA_CONTACT, waNumber: DEFAULT_WA_NUMBER };
  if (name) return { waContactName: name, waNumber: num };
  return { waContactName: num === DEFAULT_WA_NUMBER ? DEFAULT_WA_CONTACT : 'the villa contact', waNumber: num };
}

// Admin-typed WhatsApp numbers arrive in every local format ("0812...",
// "62 0899...", "+62 812-..."). Normalize to bare international digits so
// contact cards built from this feed are always tappable — a stored
// "6208993319020" once went out to an agent as an undialable card (Aug 2026).
function normalizeWaNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('620')) return '62' + d.slice(3);   // 62 + stray leading 0
  if (d.startsWith('0')) return '62' + d.slice(1);     // local 08xx format
  // Bare local without the 0 ("81233293709") gets 62 prepended — but ONLY for
  // prefixes that cannot be a foreign country code. 85x collides with Hong
  // Kong (+852) and 86x with China (+86), both of which really occur in our
  // contact data (Villa Solstice's manager is on a +86 number) — leave those
  // untouched rather than corrupt a valid international number.
  if (/^8(1|2|3|7|9)\d{8,10}$/.test(d)) return '62' + d;
  return d;
}

// Default catalog (Hostex IDs → slug/name/tag/pricing). Identity/price/order
// come from the shared canonical catalog (lib/catalog.js) so they can't drift
// from api/listings.js / api/check-availability.js. The area `tag` is kept
// here because the digest uses WhatsApp-tuned wording that deliberately differs
// from the portal's building tags (e.g. "Tumbak Bayuh, Pererenan" vs the
// portal's "Buduk · Near Canggu"). All fields stay overridable per-listing via
// /admin (KV). `unitType` feeds the WhatsApp line format ("1BR Apartment").
import { UNITS } from '../lib/catalog.js';
import { listingVisible } from './listings.js';
const DIGEST_TAG = {
  haus: 'Batu Bolong, Canggu', lanehaus: 'Pererenan',
  'villa-saturno': 'Padang Linjong, Canggu', tropicana: 'Tumbak Bayuh, Pererenan',
};
function digestTag(slug) {
  if (slug.startsWith('haus-')) return DIGEST_TAG.haus;
  if (slug.startsWith('lanehaus-')) return DIGEST_TAG.lanehaus;
  if (slug.startsWith('tropicana-')) return DIGEST_TAG.tropicana;
  return DIGEST_TAG[slug] || '';
}
const DEFAULTS = Object.fromEntries(UNITS.map(u => [u.hostexId, {
  order: u.order, slug: u.slug, name: u.name, unitType: u.unitType,
  tag: digestTag(u.slug), monthly: u.monthly, yearly: u.yearly, yearly2: u.yearly2,
}]));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Two valid auth modes:
  //   1. CRM (or any downstream consumer): Bearer DIGEST_SHARED_SECRET
  //   2. Vercel internal cron (pre-warm at 8:50am WITA): Bearer CRON_SECRET
  // The cron pre-warm bypasses the cache via ?force=1 so the CRM at 9am
  // always gets fresh data without paying the Hostex latency cost itself.
  const expected = process.env.DIGEST_SHARED_SECRET;
  const cronExpected = process.env.CRON_SECRET;
  if (!expected && !cronExpected) return res.status(500).json({ error: 'DIGEST_SHARED_SECRET not configured' });
  const auth = req.headers.authorization || '';
  const authOk = (expected && auth === `Bearer ${expected}`)
              || (cronExpected && auth === `Bearer ${cronExpected}`);
  if (!authOk) return res.status(401).json({ error: 'Unauthorized' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const hostexToken = process.env.HOSTEX_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const j = await r.json();
    if (!j.result) return null;
    try { return JSON.parse(j.result); } catch { return null; }
  }
  async function kvSet(key, value) {
    await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  }

  // ── cache check ─────────────────────────────────────────────────────
  const force = req.query?.force === '1';
  if (!force) {
    const cached = await kvGet('digest:cache');
    if (cached && cached.asOf && (Date.now() - new Date(cached.asOf).getTime()) < CACHE_TTL_MS) {
      res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
      res.setHeader('X-Digest-Cache', 'hit');
      return res.status(200).json(cached);
    }
  }

  // ── load overrides + custom properties ──────────────────────────────
  const slugs = Object.values(DEFAULTS).map(d => d.slug);
  const [customMap, ...listingOverrides] = await Promise.all([
    kvGet('custom_properties'),
    ...slugs.map(s => kvGet(`listing:${s}`)),
  ]);
  const overridesBySlug = {};
  slugs.forEach((slug, i) => { if (listingOverrides[i]) overridesBySlug[slug] = listingOverrides[i]; });

  const todayStr = isoDate(new Date());
  const horizonEnd = new Date();
  horizonEnd.setDate(horizonEnd.getDate() + HORIZON_DAYS);
  const horizonEndStr = isoDate(horizonEnd);

  // ── Hostex properties ──────────────────────────────────────────────
  const hostexResults = await Promise.all(
    Object.entries(DEFAULTS).map(async ([id, base]) => {
      const override = overridesBySlug[base.slug] || {};
      const merged = { ...base, ...override };
      let bookedSet;
      try {
        bookedSet = hostexToken
          ? await fetchHostexBooked(id, hostexToken, todayStr, horizonEndStr)
          : new Set();
      } catch (e) {
        bookedSet = new Set();
      }
      const availability = computeAvailability(bookedSet, todayStr, HORIZON_DAYS, LONG_WINDOW_DAYS);
      return {
        id,
        order: base.order,
        slug: merged.slug,
        name: merged.name,
        tag: merged.tag,
        unitType: merged.unitType || null,
        monthly: merged.monthly || null,
        yearly: merged.yearly || null,
        yearly2: merged.yearly2 || null,
        portalUrl: `${PORTAL_BASE}/l/${merged.slug}`,
        ...resolveContact(merged.waContactName, merged.waNumber),
        isCustom: false,
        isHidden: false,
        availability,
      };
    })
  );
  hostexResults.sort((a, b) => a.order - b.order);

  // ── Custom properties ──────────────────────────────────────────────
  // Same visibility rule as the public feed: pending_review owner intakes
  // must not reach Maya/agent broadcasts before approval.
  const customResults = await Promise.all(Object.values(customMap || {}).filter(c => listingVisible(c)).map(async c => {
    const bookedSet = rangesToSet(c.bookedRanges, todayStr, horizonEndStr);
    // Union in iCal bookings (e.g. a friend's Hostex/Airbnb calendar export)
    if (c.icalUrl) {
      try {
        const icsRes = await fetch(c.icalUrl, { headers: { 'User-Agent': 'SambaRentals/1.0' } });
        if (icsRes.ok) {
          const ics = await icsRes.text();
          parseIcsBookedDates(ics, todayStr, horizonEndStr).forEach(d => bookedSet.add(d));
        }
      } catch {}
    }
    const availability = computeAvailability(bookedSet, todayStr, HORIZON_DAYS, LONG_WINDOW_DAYS);
    return {
      id: 'c_' + c.slug,
      slug: c.slug,
      name: c.name,
      tag: c.tag || '',
      unitType: c.unitType || null,
      monthly: c.monthly || null,
      yearly: c.yearly || null,
      yearly2: c.yearly2 || null,
      portalUrl: `${PORTAL_BASE}/l/${c.slug}`,
      ...resolveContact(c.waContactName, c.waNumber),
      isCustom: true,
      isHidden: false,
      availability,
    };
  }));
  // Customs sort alphabetically after the Hostex building groups — units of
  // the same custom building share a name prefix so they end up adjacent.
  customResults.sort((a, b) => a.name.localeCompare(b.name));

  const payload = {
    asOf: new Date().toISOString(),
    portalBase: PORTAL_BASE,
    horizonDays: HORIZON_DAYS,
    longWindowDays: LONG_WINDOW_DAYS,
    properties: [...hostexResults, ...customResults],
  };

  await kvSet('digest:cache', payload).catch(() => {});
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
  res.setHeader('X-Digest-Cache', 'miss');
  return res.status(200).json(payload);
}

// ── helpers ──────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

// Convert {from,to} ranges (inclusive) to a Set of YYYY-MM-DD strings,
// clipped to [todayStr, horizonEndStr]. Overlapping ranges merge naturally.
function rangesToSet(ranges, todayStr, horizonEndStr) {
  const out = new Set();
  for (const r of ranges || []) {
    if (!r || !r.from || !r.to) continue;
    let cur = r.from < todayStr ? todayStr : r.from;
    const end = r.to > horizonEndStr ? horizonEndStr : r.to;
    while (cur <= end) {
      out.add(cur);
      cur = addDays(cur, 1);
    }
  }
  return out;
}

// availableToday + next-available + first day of next >=long-window-day run.
// Iterates the horizon once; O(horizon) — well under 200 ops for our window.
function computeAvailability(bookedSet, todayStr, horizonDays, longWindowDays) {
  const availableToday = !bookedSet.has(todayStr);
  let nextAvailableFrom = null;
  let nextLongWindowFrom = null;
  let longWindowDaysActual = 0;

  for (let i = 0; i < horizonDays; i++) {
    const d = addDays(todayStr, i);
    if (!bookedSet.has(d) && nextAvailableFrom === null) {
      nextAvailableFrom = d;
    }
  }

  // Sliding scan for first long-enough open run
  let runStart = null;
  let runLen = 0;
  for (let i = 0; i < horizonDays; i++) {
    const d = addDays(todayStr, i);
    if (!bookedSet.has(d)) {
      if (runStart === null) runStart = d;
      runLen++;
      if (runLen >= longWindowDays && nextLongWindowFrom === null) {
        nextLongWindowFrom = runStart;
      }
      if (nextLongWindowFrom !== null) {
        longWindowDaysActual = runLen;
      }
    } else {
      if (nextLongWindowFrom !== null) break; // run that satisfied the window has ended
      runStart = null;
      runLen = 0;
    }
  }

  return {
    availableToday,
    nextAvailableFrom,
    nextLongWindowFrom,
    longWindowDays: longWindowDaysActual,
  };
}

// Parse VEVENT blocks into booked YYYY-MM-DD dates (duplicated in
// api/ical.js — keep in sync). DTEND exclusive; cancelled events skipped.
function parseIcsBookedDates(ics, horizonStart, horizonEnd) {
  const unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1);
  const booked = new Set();
  for (const ev of events) {
    if (/STATUS\s*:\s*CANCELLED/i.test(ev)) continue;
    const ds = ev.match(/DTSTART[^:]*:(\d{8})/);
    if (!ds) continue;
    const de = ev.match(/DTEND[^:]*:(\d{8})/);
    const fmt = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    const start = fmt(ds[1]);
    const end = de ? fmt(de[1]) : addDays(start, 1);
    let cur = start < horizonStart ? horizonStart : start;
    while (cur < end && cur <= horizonEnd) {
      booked.add(cur);
      cur = addDays(cur, 1);
    }
  }
  return booked;
}

// Mirror of the logic in api/calendar.js: reservations + closed availabilities
// from Hostex collapse into a single Set of booked YYYY-MM-DD strings.
async function fetchHostexBooked(id, token, startDate, endDate) {
  const [resRes, availRes] = await Promise.all([
    fetch(`https://api.hostex.io/v3/reservations?property_id=${id}&per_page=100&page=1`, {
      headers: { 'Hostex-Access-Token': token },
    }),
    fetch(`https://api.hostex.io/v3/availabilities?property_ids=${id}&start_date=${startDate}&end_date=${endDate}`, {
      headers: { 'Hostex-Access-Token': token },
    }),
  ]);
  const resData = await resRes.json();
  const availData = await availRes.json();

  const booked = new Set();
  for (const r of resData.data?.reservations || []) {
    if (r.status === 'cancelled') continue;
    let cur = r.check_in_date;
    while (cur < r.check_out_date) {
      booked.add(cur);
      cur = addDays(cur, 1);
    }
  }
  for (const prop of availData.data?.properties || []) {
    for (const a of prop.availabilities || []) {
      if (a.available === false) booked.add(a.date);
    }
  }
  return booked;
}
