// Point availability check for a single property over a specific date range.
// GET /api/check-availability?slug=<slug>&check_in=YYYY-MM-DD&check_out=YYYY-MM-DD
//
// Authoritative answer to "is property X free from D1 to D2?" for BOTH Hostex
// listings and custom (KV) properties — the CRM's Maya bot calls this when an
// agent asks about a specific date range (api/digest.js only summarises
// available-now / next-free / next-30-day-window).
//
// check_out is the departure day and is treated as EXCLUSIVE (hotel convention),
// matching Hostex reservation semantics. Auth: Bearer DIGEST_SHARED_SECRET
// (same secret the digest uses), or CRON_SECRET for internal callers.

// Hostex catalog (id -> slug/name) — mirrors api/digest.js DEFAULTS. Inlined so
// the endpoint resolves slugs even when the listings KV blob is empty.
const HOSTEX = {
  'haus-1':        { id: '11621510', name: 'HAUS Canggu – Unit 1' },
  'haus-2':        { id: '11621511', name: 'HAUS Canggu – Unit 2' },
  'haus-4':        { id: '11621512', name: 'HAUS Canggu – Unit 4' },
  'haus-5':        { id: '11621513', name: 'HAUS Canggu – Unit 5' },
  'lanehaus-1':    { id: '11621507', name: 'LaneHAUS – Unit 1' },
  'lanehaus-3':    { id: '11621509', name: 'LaneHAUS – Unit 3' },
  'villa-saturno': { id: '12552236', name: 'Villa Saturno' },
  'tropicana-a4':  { id: '12484483', name: 'Tropicana Valley – Unit A4' },
  'tropicana-a5':  { id: '12450063', name: 'Tropicana Valley – Unit A5' },
  'tropicana-b2':  { id: '12566585', name: 'Tropicana Valley – Unit B2' },
  'tropicana-b3':  { id: '12566586', name: 'Tropicana Valley – Unit B3' },
  'tropicana-b4':  { id: '12606732', name: 'Tropicana Valley – Unit B4' },
  'tropicana-b5':  { id: '12566587', name: 'Tropicana Valley – Unit B5' },
  'tropicana-b6':  { id: '12566588', name: 'Tropicana Valley – Unit B6' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const expected = process.env.DIGEST_SHARED_SECRET;
  const cronExpected = process.env.CRON_SECRET;
  if (!expected && !cronExpected) return res.status(500).json({ error: 'DIGEST_SHARED_SECRET not configured' });
  const auth = req.headers.authorization || '';
  const authOk = (expected && auth === `Bearer ${expected}`) || (cronExpected && auth === `Bearer ${cronExpected}`);
  if (!authOk) return res.status(401).json({ error: 'Unauthorized' });

  const slug = String(req.query.slug || '').trim();
  const checkIn = String(req.query.check_in || '').trim();
  const checkOut = String(req.query.check_out || '').trim();
  if (!slug) return res.status(400).json({ error: 'Missing slug' });
  if (!DATE_RE.test(checkIn) || !DATE_RE.test(checkOut)) {
    return res.status(400).json({ error: 'check_in and check_out must be YYYY-MM-DD' });
  }
  if (checkOut <= checkIn) return res.status(400).json({ error: 'check_out must be after check_in' });
  // Range nights = [check_in, check_out)
  const nights = daysBetween(checkIn, checkOut);
  if (nights > MAX_RANGE_DAYS) return res.status(400).json({ error: `Range too long (max ${MAX_RANGE_DAYS} nights)` });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const hostexToken = process.env.HOSTEX_TOKEN;

  async function kvGet(key) {
    if (!kvUrl || !kvToken) return null;
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const j = await r.json();
    if (!j.result) return null;
    try { return JSON.parse(j.result); } catch { return null; }
  }

  // Last bookable night we care about is the night before check_out.
  const lastNight = addDays(checkOut, -1);

  let name = slug;
  let bookedSet = new Set();

  try {
    if (HOSTEX[slug]) {
      // Allow per-listing name override from KV, fall back to catalog name.
      const override = await kvGet(`listing:${slug}`);
      name = (override && override.name) || HOSTEX[slug].name;
      bookedSet = hostexToken
        ? await fetchHostexBooked(HOSTEX[slug].id, hostexToken, checkIn, checkOut)
        : new Set();
    } else {
      // Custom property (KV). Accept either kebab or snake slug from callers.
      const customMap = await kvGet('custom_properties') || {};
      const custom = customMap[slug] || customMap[slug.replace(/_/g, '-')];
      if (!custom) return res.status(404).json({ error: 'Unknown property slug', slug });
      name = custom.name || slug;
      bookedSet = rangesToSet(custom.bookedRanges, checkIn, lastNight);
      if (custom.icalUrl) {
        try {
          const icsRes = await fetch(custom.icalUrl, { headers: { 'User-Agent': 'SambaRentals/1.0' } });
          if (icsRes.ok) parseIcsBookedDates(await icsRes.text(), checkIn, lastNight).forEach(d => bookedSet.add(d));
        } catch { /* iCal optional */ }
      }
    }
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }

  // Collect every booked night that falls inside [check_in, check_out).
  const bookedDates = [];
  let cur = checkIn;
  while (cur < checkOut) {
    if (bookedSet.has(cur)) bookedDates.push(cur);
    cur = addDays(cur, 1);
  }

  return res.status(200).json({
    slug,
    name,
    check_in: checkIn,
    check_out: checkOut,
    nights,
    available: bookedDates.length === 0,
    bookedDates,
  });
}

// ── helpers (kept in sync with api/digest.js) ────────────────────────

function isoDate(d) { return d.toISOString().split('T')[0]; }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

function rangesToSet(ranges, startStr, endStr) {
  const out = new Set();
  for (const r of ranges || []) {
    if (!r || !r.from || !r.to) continue;
    let cur = r.from < startStr ? startStr : r.from;
    const end = r.to > endStr ? endStr : r.to;
    while (cur <= end) { out.add(cur); cur = addDays(cur, 1); }
  }
  return out;
}

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
    while (cur < end && cur <= horizonEnd) { booked.add(cur); cur = addDays(cur, 1); }
  }
  return booked;
}

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
    while (cur < r.check_out_date) { booked.add(cur); cur = addDays(cur, 1); }
  }
  for (const prop of availData.data?.properties || []) {
    for (const a of prop.availabilities || []) {
      if (a.available === false) booked.add(a.date);
    }
  }
  return booked;
}
