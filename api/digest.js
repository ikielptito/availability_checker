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
const PORTAL_BASE = 'https://sambarentals.vercel.app';

// Default catalog (Hostex IDs → slug/name/tag/pricing) — kept in sync with
// api/listings.js DEFAULTS. We inline the names so the digest is self-contained
// even when the listings KV blob is empty (first deploy, fresh dev server).
// `order` groups buildings together with units in sequence (HAUS block,
// then LaneHAUS, then Villa Saturno, then Tropicana) — consumers render
// lists in this order. `unitType` feeds the WhatsApp line format
// ("1BR Apartment"). Both are overridable per-listing via /admin (KV).
const DEFAULTS = {
  '11621510': { order: 10, slug: 'haus-1',        name: 'HAUS Canggu – Unit 1',      unitType: '1BR Apartment', tag: 'Batu Bolong, Canggu',    monthly: '27jt', yearly: '270jt' },
  '11621511': { order: 11, slug: 'haus-2',        name: 'HAUS Canggu – Unit 2',      unitType: '1BR Apartment', tag: 'Batu Bolong, Canggu',    monthly: '27jt', yearly: '270jt' },
  '11621512': { order: 12, slug: 'haus-4',        name: 'HAUS Canggu – Unit 4',      unitType: '1BR Apartment', tag: 'Batu Bolong, Canggu',    monthly: '30jt', yearly: '300jt' },
  '11621513': { order: 13, slug: 'haus-5',        name: 'HAUS Canggu – Unit 5',      unitType: '1BR Apartment', tag: 'Batu Bolong, Canggu',    monthly: '30jt', yearly: '300jt' },
  '11621507': { order: 20, slug: 'lanehaus-1',    name: 'LaneHAUS – Unit 1',          unitType: '1BR Townhouse', tag: 'Pererenan',              monthly: '24jt', yearly: '240jt' },
  '11621509': { order: 21, slug: 'lanehaus-3',    name: 'LaneHAUS – Unit 3',          unitType: '1BR Townhouse', tag: 'Pererenan',              monthly: '22jt', yearly: '220jt' },
  '12552236': { order: 30, slug: 'villa-saturno', name: 'Villa Saturno',              unitType: '3BR Villa',     tag: 'Padang Linjong, Canggu', monthly: '40jt', yearly: '350jt', yearly2: '600jt' },
  '12484483': { order: 40, slug: 'tropicana-a4',  name: 'Tropicana Valley – Unit A4', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12450063': { order: 41, slug: 'tropicana-a5',  name: 'Tropicana Valley – Unit A5', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12566585': { order: 42, slug: 'tropicana-b2',  name: 'Tropicana Valley – Unit B2', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12566586': { order: 43, slug: 'tropicana-b3',  name: 'Tropicana Valley – Unit B3', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12606732': { order: 44, slug: 'tropicana-b4',  name: 'Tropicana Valley – Unit B4', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12566587': { order: 45, slug: 'tropicana-b5',  name: 'Tropicana Valley – Unit B5', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
  '12566588': { order: 46, slug: 'tropicana-b6',  name: 'Tropicana Valley – Unit B6', unitType: '1BR Villa',     tag: 'Tumbak Bayuh, Pererenan', monthly: '30jt', yearly: '300jt' },
};

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
        isCustom: false,
        isHidden: false,
        availability,
      };
    })
  );
  hostexResults.sort((a, b) => a.order - b.order);

  // ── Custom properties ──────────────────────────────────────────────
  const customResults = await Promise.all(Object.values(customMap || {}).filter(c => !c.hidden).map(async c => {
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
