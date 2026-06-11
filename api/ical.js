// iCal availability sync for custom properties.
// GET /api/ical?slug=<custom-slug> → { booked: ["YYYY-MM-DD", ...] }
//
// The slug must belong to a custom property with an icalUrl saved in KV —
// we never proxy arbitrary URLs (SSRF). Failures return 200 with an empty
// list so the portal degrades gracefully to manual booked ranges.

const HORIZON_DAYS = 200;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  const slug = req.query.slug;
  if (!slug || !/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });

  const r = await fetch(`${kvUrl}/get/custom_properties`, { headers: { Authorization: `Bearer ${kvToken}` } });
  const j = await r.json();
  let customs = null;
  try { customs = JSON.parse(j.result); } catch {}
  const prop = customs?.[slug];
  if (!prop) return res.status(404).json({ error: 'Unknown custom property' });
  if (!prop.icalUrl) return res.status(200).json({ booked: [], note: 'No iCal URL configured' });

  const todayStr = isoDate(new Date());
  const horizonEnd = new Date();
  horizonEnd.setDate(horizonEnd.getDate() + HORIZON_DAYS);

  try {
    const icsRes = await fetch(prop.icalUrl, { headers: { 'User-Agent': 'SambaRentals/1.0' } });
    if (!icsRes.ok) return res.status(200).json({ booked: [], error: `iCal fetch ${icsRes.status}` });
    const ics = await icsRes.text();
    const booked = parseIcsBookedDates(ics, todayStr, isoDate(horizonEnd));
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ booked: [...booked].sort(), source: 'ical' });
  } catch (e) {
    return res.status(200).json({ booked: [], error: e.message });
  }
}

// ── helpers (duplicated in api/digest.js — keep in sync) ─────────────

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

// Parse VEVENT blocks into a Set of booked YYYY-MM-DD strings, clipped to
// [horizonStart, horizonEnd]. DTEND is exclusive per RFC 5545 (checkout day
// stays available). Handles both all-day (VALUE=DATE) and datetime forms —
// the \d{8} capture grabs the date part of either. Cancelled events skipped.
export function parseIcsBookedDates(ics, horizonStart, horizonEnd) {
  // Unfold continuation lines (RFC 5545: CRLF followed by space or tab)
  const unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1);
  const booked = new Set();
  for (const ev of events) {
    if (/STATUS\s*:\s*CANCELLED/i.test(ev)) continue;
    const ds = ev.match(/DTSTART[^:]*:(\d{8})/);
    if (!ds) continue;
    const de = ev.match(/DTEND[^:]*:(\d{8})/);
    const start = fmtIcsDate(ds[1]);
    const end = de ? fmtIcsDate(de[1]) : addDays(start, 1); // no DTEND → single day
    let cur = start < horizonStart ? horizonStart : start;
    while (cur < end && cur <= horizonEnd) {
      booked.add(cur);
      cur = addDays(cur, 1);
    }
  }
  return booked;
}

function fmtIcsDate(s) {
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
