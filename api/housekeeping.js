// Housekeeping — the portal side. A thin admin proxy, the same shape as
// api/staff.js: Ikiel or Era authenticate with the admin password, and this
// route forwards hk_* actions to the CRM using LISTING_SYNC_SECRET.
//
// Nothing owner-facing lives here. Owners see inspection findings through
// their weekly report, which is built by api/portal.js from the same records
// but carries no staff names or numbers.

import { calendarSig, verifyCalendarSig } from '../lib/tokens.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // GET /api/housekeeping?ics=<sig> — the schedule as an iCalendar feed, for
  // Google Calendar. Everything the Schedule page shows: cleans, inspection
  // rounds, deep cleans (the next six months projected), and guest
  // movements. Signed, not public.
  if (req.method === 'GET') return serveCalendar(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const adminPasswords = [
    process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD,
    process.env.STATEMENTS_ADMIN_PASSWORD,      // Era's scoped credential
  ].filter(Boolean);
  if (!adminPasswords.length) return res.status(503).json({ error: 'Admin password not configured' });

  const auth = req.headers.authorization || '';
  if (!adminPasswords.some(p => auth === `Bearer ${p}`)) return res.status(401).json({ error: 'Unauthorized' });

  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });

  const { action, payload } = req.body || {};
  if (!/^hk_[a-z_]+$/.test(String(action || ''))) {
    return res.status(400).json({ error: `unsupported action: ${action}` });
  }
  // Answered here, not by the CRM: the feed URL is this host's.
  if (action === 'hk_calendar_url') {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sambarentals.com';
    return res.status(200).json({ url: `https://${host}/api/housekeeping?ics=${calendarSig()}` });
  }

  try {
    const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
    const r = await fetch(`${crmBase}/api/housekeeping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload: payload || {} }),
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.status).json(await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` })));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function serveCalendar(req, res) {
  if (!verifyCalendarSig(String(req.query.ics || ''))) return res.status(401).send('Unauthorized');
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).send('LISTING_SYNC_SECRET not configured');
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  let data;
  try {
    const r = await fetch(`${crmBase}/api/housekeeping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action: 'hk_calendar', payload: { months: 6 } }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || `CRM ${r.status}`);
  } catch (e) {
    return res.status(502).send(`Calendar unavailable: ${e.message}`);
  }
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const ymd = (d) => String(d).replace(/-/g, '');
  const next = (d) => new Date(Date.parse(d) + 86400e3).toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Samba Rentals//Housekeeping//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Samba villas — schedule', 'X-WR-TIMEZONE:Asia/Makassar',
  ];
  for (const e of (data.events || [])) {
    lines.push('BEGIN:VEVENT',
      `UID:${esc(e.uid)}@sambarentals.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(e.date)}`,
      `DTEND;VALUE=DATE:${ymd(next(e.date))}`,
      `SUMMARY:${esc(e.title)}`,
      `CATEGORIES:${esc(e.kind)}`,
      `STATUS:${e.status === 'projected' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  // Folded at 75 octets per RFC 5545; Google tolerates long lines but Apple
  // Calendar does not.
  const body = lines.map(l => { const out = []; let s = l; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); }).join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).send(body);
}

