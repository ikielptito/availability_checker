// Housekeeping — the portal side. A thin admin proxy, the same shape as
// api/staff.js: Ikiel or Era authenticate with the admin password, and this
// route forwards hk_* actions to the CRM using LISTING_SYNC_SECRET.
//
// Nothing owner-facing lives here. Owners see inspection findings through
// their weekly report, which is built by api/portal.js from the same records
// but carries no staff names or numbers.

import { calendarSig, verifyCalendarSig, recordToken, verifyRecordToken } from '../lib/tokens.js';
import { buildPdf } from '../lib/pdf.js';
import { staysFrom } from '../lib/turnovers.js';
import { fetchAllReservations } from '../lib/month-stats.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // GET /api/housekeeping?ics=<sig> — the schedule as an iCalendar feed, for
  // Google Calendar. Everything the Schedule page shows: cleans, inspection
  // rounds, deep cleans (the next six months projected), and guest
  // movements. Signed, not public.
  if (req.method === 'GET' && req.query.record) return serveRecordPdf(req, res);
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
  if (action === 'hk_record_link') {
    const type = payload?.type === 'inspection' ? 'inspection' : 'handover';
    const id = parseInt(payload?.id, 10);
    if (!id) return res.status(400).json({ error: 'id required' });
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sambarentals.com';
    return res.status(200).json({ url: `https://${host}/api/housekeeping?record=${recordToken(type, id)}` });
  }
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

// The record as a PDF: header, who and when, the guest it sits before or
// after, what Maya flagged, what the housekeeper wrote, the repairs, and
// every photo. Built on the fly from the CRM's export and the photos in
// the bucket, so the link never goes stale.
async function serveRecordPdf(req, res) {
  const tok = verifyRecordToken(String(req.query.record || ''));
  if (!tok) return res.status(401).send('This link is not valid.');
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).send('LISTING_SYNC_SECRET not configured');
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  let data;
  try {
    const r = await fetch(`${crmBase}/api/housekeeping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action: 'hk_record_export', payload: { type: tok.type, id: tok.id } }),
    });
    data = await r.json();
    if (!r.ok) throw new Error(data.error || `CRM ${r.status}`);
  } catch (e) { return res.status(502).send(`Record unavailable: ${e.message}`); }
  const rec = data.record;
  const villa = String(data.villa || rec.slug).replace(/\s*[–—]\s*/g, ' · ');
  const fmt = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
  const short = (d) => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
  const KIND = { turnover: 'Turnover clean', regular: 'Regular clean', pre_arrival: 'Pre-arrival preparation', deep_clean: 'Deep clean', inspection: 'Inspection round' };
  const STATUS = { pass: 'Checked, nothing to fix', flagged: 'Checked, issues flagged', unchecked: 'Not checked (no photos received)', awaiting: 'Photos pending', clear: 'Nothing found', raised: 'Repairs raised' };

  // Guest context from the Hostex calendar, when it is reachable.
  const guests = [];
  try {
    const hx = process.env.HOSTEX_TOKEN;
    if (hx) {
      const { UNITS } = await import('../lib/catalog.js');
      const unit = (UNITS || []).find(u => u.slug === rec.slug);
      if (unit?.hostexId) {
        // A year back from the record, the same reader the schedule uses.
        const since = new Date(Date.parse(rec.date) - 365 * 86400e3).toISOString().slice(0, 10);
        const stays = staysFrom(await fetchAllReservations(unit.hostexId, since));
        const before = stays.find(s => s.check_in >= rec.date);
        const after = [...stays].reverse().find(s => s.check_out <= rec.date);
        const during = stays.find(s => s.check_in < rec.date && s.check_out > rec.date);
        const g = (s) => `${s.guest || 'Guest'}, ${short(s.check_in)} to ${short(s.check_out)} (${s.nights} nights, ${s.channel || 'booking'})`;
        if (after) guests.push(`After the stay of ${g(after)}`);
        if (during) guests.push(`During the stay of ${g(during)}`);
        if (before) guests.push(`Before the arrival of ${g(before)}`);
      }
    }
  } catch { /* guest context is a nicety */ }

  const photos = [];
  for (const [i, u] of (data.photo_urls || []).entries()) {
    try {
      const r = await fetch(u);
      if (r.ok) photos.push({ buf: Buffer.from(await r.arrayBuffer()), caption: `Photo ${i + 1} of ${data.photo_urls.length}` });
    } catch { /* skip */ }
  }
  const bad = (rec.checks || []).filter(c => c.ok === false);
  const otherFlags = (rec.flags || []).filter(f => !bad.some(c => f.startsWith(c.spot + ':')));
  const pdf = buildPdf({
    title: `${villa}`,
    subtitle: `${rec.type === 'inspection' ? 'Inspection round' : 'Handover record'} · ${fmt(rec.date)}`,
    meta: [
      ['Type', KIND[rec.kind] || rec.kind],
      ['Housekeeper', rec.staff || 'Unknown'],
      ['Result', STATUS[rec.status] || rec.status],
      ...(rec.guest_in_date ? [['Prepared for', `Guest arriving ${short(rec.guest_in_date)}`]] : []),
      ['Photos', String((data.photo_urls || []).length)],
      ['Record', `${rec.type} #${rec.id}, taken ${new Date(rec.at).toLocaleString('en-GB', { timeZone: 'Asia/Makassar' })} WITA`],
    ],
    sections: [
      guests.length ? { heading: 'BOOKINGS AROUND THIS RECORD', lines: guests } : null,
      bad.length || otherFlags.length ? { heading: 'FLAGGED BY THE PHOTO CHECK', lines: [...bad.map(c => `${c.spot}: ${c.note || 'not right'}`), ...otherFlags] } : null,
      rec.restock ? { heading: 'RUNNING LOW', text: rec.restock } : null,
      rec.findings ? { heading: 'WHAT THE HOUSEKEEPER REPORTED', text: rec.findings } : null,
      (data.repairs || []).length ? { heading: 'REPAIRS RAISED FROM THIS RECORD', lines: data.repairs.map(r => `${r.title} (${r.status})`) } : null,
      { heading: 'ABOUT THIS RECORD', text: rec.type === 'inspection'
        ? 'A fortnightly inspection round: the housekeeper walks the villa, photographs it and reports anything wrong. Photos are stored when received and are not edited.'
        : 'A handover record: after preparing the villa for a guest, the housekeeper photographs each room and Maya, Samba\u2019s assistant, checks the photos before the guest arrives. Photos are stored when received and are not edited.' },
    ],
    photos,
    footer: `Samba Realty · Bali · generated ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Makassar' })}`,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Samba-${rec.slug}-${rec.date}-${rec.type}.pdf"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).send(pdf);
}

