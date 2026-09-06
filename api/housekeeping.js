// Housekeeping — the portal side. A thin admin proxy, the same shape as
// api/staff.js: Ikiel or Era authenticate with the admin password, and this
// route forwards hk_* actions to the CRM using LISTING_SYNC_SECRET.
//
// Owner-facing, read-only:
//   GET ?action=owner                 the owner's cleaning log and what is
//                                     planned next (session or preview token)
//   GET ?action=owner-photos&type&id  signed photo URLs for one of their records
//   GET ?record=<token>               a record as a PDF; the "owner" audience
//                                     carries no housekeeper name
// Owners see outcomes, never staff names or numbers — the same rule as the
// weekly report.

import { calendarSig, verifyCalendarSig, recordToken, verifyRecordToken, verifyPreviewToken, todaySig, verifyTodaySig } from '../lib/tokens.js';
import { isCockpitAdmin, adminPasswordsConfigured } from '../lib/cockpit-auth.js';
import { makeKvGet, sessionOwner, ownerSlugs } from '../lib/owner-session.js';
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
  if (req.method === 'GET' && req.query.today) return serveToday(req, res);
  if (req.method === 'GET' && req.query.record) return serveRecordPdf(req, res);
  if (req.method === 'GET' && req.query.action) return serveOwner(req, res);
  if (req.method === 'GET') return serveCalendar(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!adminPasswordsConfigured()) return res.status(503).json({ error: 'Admin password not configured' });
  // Ikiel's passwords, Era's password, or Era's WhatsApp-link session.
  if (!(await isCockpitAdmin(req.headers.authorization))) return res.status(401).json({ error: 'Unauthorized' });

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
  if (action === 'hk_today_url') {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'sambarentals.com';
    return res.status(200).json({ url: `https://${host}/today/${todaySig()}` });
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

// ── The portal's Housekeeping tab ───────────────────────────────────
async function serveOwner(req, res) {
  const action = String(req.query.action || '');
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const crm = async (route, act, payload) => {
    const r = await fetch(`${crmBase}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action: act, payload }),
      signal: AbortSignal.timeout(9000),
    });
    return { status: r.status, body: await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` })) };
  };
  const fetchGroups = async () => (await crm('statements', 'statement_groups', {})).body?.groups || [];

  // Whose villas: an admin preview of one group, or the signed-in owner.
  let slugs = [];
  const previewGroup = verifyPreviewToken(req.query.preview || '');
  if (previewGroup) {
    slugs = (await fetchGroups()).filter(g => g.key === previewGroup).flatMap(g => g.listing_slugs || []);
  } else {
    const owner = await sessionOwner(req, makeKvGet());
    if (!owner) return res.status(401).json({ error: 'Not signed in' });
    slugs = await ownerSlugs(owner, makeKvGet(), fetchGroups);
  }
  res.setHeader('Cache-Control', 'no-store');
  if (!slugs.length) return res.status(200).json({ names: {}, records: [], upcoming: [] });

  try {
    if (action === 'owner') {
      const { status, body } = await crm('housekeeping', 'hk_owner_records', { slugs });
      if (status !== 200) return res.status(status).json(body);
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'sambarentals.com';
      body.records = (body.records || []).map(r => r.type === 'clean' ? r
        : { ...r, pdf_url: `https://${host}/api/housekeeping?record=${recordToken(r.type, r.id, 'owner')}` });
      return res.status(200).json({ ...body, ...(previewGroup ? { preview: true } : {}) });
    }
    if (action === 'owner-photos') {
      const type = req.query.type === 'inspection' ? 'inspection' : 'handover';
      const id = parseInt(req.query.id, 10);
      if (!id) return res.status(400).json({ error: 'id required' });
      const { status, body } = await crm('housekeeping', 'hk_owner_record_photos', { type, id, slugs });
      return res.status(status).json(body);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}

// ── Era's day, as a page ────────────────────────────────────────────
// Opened from the button on Maya's 07:05 brief. Phone-first, read-only,
// built from the same data the Schedule page uses (the CRM's hk_era_brief).
async function serveToday(req, res) {
  if (!verifyTodaySig(String(req.query.today || ''))) return res.status(401).send('Unauthorized');
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).send('LISTING_SYNC_SECRET not configured');
  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.d || '')) ? req.query.d : null;
  let b;
  try {
    const r = await fetch(`${crmBase}/api/housekeeping`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` }, body: JSON.stringify({ action: 'hk_era_brief', payload: { date } }), signal: AbortSignal.timeout(25000) });
    b = await r.json();
    if (!r.ok) throw new Error(b.error || `CRM ${r.status}`);
  } catch (e) { return res.status(502).send(`Today unavailable: ${e.message}`); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.setHeader('X-Robots-Tag', 'noindex');
  return res.status(200).send(renderToday(b, String(req.query.today)));
}

function renderToday(b, sig) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pname = (s) => String(s || '').replace(/\s*[–—]\s*/g, ' · ');
  const first = (n) => String(n || '').trim().split(/\s+/)[0];
  const tm = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' }) : '';
  const prev = new Date(Date.parse(b.date) - 86400e3).toISOString().slice(0, 10), next = new Date(Date.parse(b.date) + 86400e3).toISOString().slice(0, 10);
  const g = b.guests || {};
  const chip = (t, cls = '') => `<span class="chip ${cls}">${esc(t)}</span>`;
  const stayRow = (s, what) => `<div class="row"><div><b>${esc(pname(s.villa))}</b><div class="sub">${esc(s.guest || 'Guest')} · ${esc(s.channel || 'booking')} · ${s.nights} night${s.nights === 1 ? '' : 's'}${what === 'arrive' ? ` · until ${esc(s.check_out)}` : ''}</div></div>${what === 'arrive' ? chip(s.same_day ? 'Arrives · same-day' : 'Arrives', s.same_day ? 'warn' : 'ok') : chip('Leaves', 'muted')}</div>`;
  const guestsHtml = g.unavailable ? '<div class="empty">Booking calendar unavailable right now.</div>'
    : (!g.departures.length && !g.arrivals.length && !g.tomorrow_arrivals.length) ? '<div class="empty">No guest movements today.</div>'
    : [...g.departures.map(s => stayRow(s, 'leave')), ...g.arrivals.map(s => stayRow(s, 'arrive')),
       ...(g.tomorrow_arrivals.length ? [`<div class="sub" style="margin-top:8px">Tomorrow: ${g.tomorrow_arrivals.map(s => `${esc(pname(s.villa))} (${esc(first(s.guest) || s.channel || 'guest')})`).join(', ')}</div>`] : [])].join('');
  const visit = (v) => `<div class="row"><div><b>${esc(pname(v.villa))}</b><div class="sub">${esc(v.label)}${v.same_day ? ' · same-day turnover' : ''}${v.guest_in ? ` · guest ${esc(v.guest_in)}` : ''}${v.notes ? ` · ${esc(v.notes)}` : ''}</div></div>${v.photo_check ? chip('📷 photo check', 'ok') : ''}${chip(v.status === 'done' ? 'done' : v.status === 'notified' ? 'sent' : v.status, v.status === 'done' ? 'ok' : 'muted')}</div>`;
  const cleaningHtml = (b.cleaning || []).length ? b.cleaning.map(p => `<h3 class="${p.who === 'Unassigned' ? 'warn' : ''}">${esc(p.who)} <span class="n">${p.visits.length}</span></h3>${p.visits.map(visit).join('')}`).join('') : '<div class="empty">No cleaning today.</div>';
  const tukangHtml = (b.tukang || []).length ? b.tukang.map(t => `<div class="row"><div><b>${esc(pname(t.villa))}</b><div class="sub">#${t.ticket} ${esc(t.title)}${t.who ? ` · ${esc(t.who)}` : ''}</div></div>${chip(`${tm(t.at)}${t.confirmed ? '' : ' · unconfirmed'}`, t.confirmed ? 'ok' : 'warn')}</div>`).join('') : '';
  const backlogHtml = (b.backlog || []).length ? b.backlog.map(x => `<a class="row link" href="https://sambarentals.com/payouts#/maintenance"><div><b>#${x.id} ${esc(x.title)}</b><div class="sub">${esc(pname(x.place || ''))} · ${esc(x.action || x.status)}</div></div>${chip(x.age || `${x.age_days}d`, (x.age_days || 0) >= 3 ? 'warn' : 'muted')}</a>`).join('') : '<div class="empty">Nothing waiting on you. 🎉</div>';
  const relaysHtml = (b.relays || []).map(r => `<div class="row"><div><b>${esc(pname(r.villa || ''))}</b><div class="sub">${esc(r.question)}</div></div>${chip('reply to Maya', 'warn')}</div>`).join('');
  const viewingsHtml = (b.viewings || []).map(v => `<div class="row"><div><b>${esc(pname(v.villa || ''))}</b><div class="sub">${esc(v.agent || 'agent')} · ${esc(v.status)}</div></div>${chip(tm(v.at), 'ok')}</div>`).join('');
  const looseHtml = [...(b.loose?.not_done || []).map(x => `<div class="row"><div><b>${esc(pname(x.villa))}</b><div class="sub">${esc(x.kind)}${x.who ? ` · ${esc(x.who)}` : ''}</div></div>${chip('not marked done', 'warn')}</div>`), ...(b.loose?.readiness || []).map(x => `<div class="row"><div><b>${esc(pname(x.villa))}</b><div class="sub">${esc((x.flags || []).join('; ') || 'no photos received')}</div></div>${chip(x.status === 'unchecked' ? 'no photos' : 'flagged', 'warn')}</div>`)].join('');
  const week = b.week || { days: [] };
  const weekHtml = week.days.map(d => `<div class="day"><div class="dl">${esc(d.label)}</div><div class="dd">${d.arrivals.map(a => `<span class="chip ok">→ ${esc(pname(a.villa))}</span>`).join('')}${d.departures.map(a => `<span class="chip muted">← ${esc(pname(a.villa))}</span>`).join('')}${d.rounds.map(r => `<span class="chip">${esc(r.kind)} ${esc(pname(r.villa))}${r.who ? ` (${esc(first(r.who))})` : ''}</span>`).join('')}${d.cleans ? `<span class="sub">${d.cleans} clean${d.cleans === 1 ? '' : 's'}</span>` : ''}${!d.arrivals.length && !d.departures.length && !d.rounds.length && !d.cleans ? '<span class="sub">—</span>' : ''}</div></div>`).join('');
  const moneyHtml = (week.statements_unpublished || []).length ? `<div class="sub" style="margin-top:8px">Statements for ${esc(week.prev_period)} not yet published: ${week.statements_unpublished.map(s => `${esc(pname(s.group))} (${esc(s.status)})`).join(', ')} — <a href="https://sambarentals.com/payouts#/">Payouts</a></div>` : '';
  const section = (title, body, extra = '') => `<section><h2>${esc(title)}${extra}</h2>${body}</section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Today · ${esc(b.label)}</title>
<style>
:root{--terra:#E2572B;--ink:#131A17;--sand:#E9E2D6;--olive:#6F7A5A;--sage:#B9C1A6;--off:#F4F1ED;--muted:#6b6b66;--line:#e6e0d6;--card:#fff}
*{box-sizing:border-box}body{margin:0;background:var(--off);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;padding:14px 12px 60px;max-width:640px;margin:0 auto}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:8px}.brand .mark{width:26px;height:26px;border-radius:50%;background:var(--terra);color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px}.brand .wm{font-family:'Iowan Old Style',Georgia,serif;font-size:1.05rem}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:6px 0 14px;flex-wrap:wrap}.nav{white-space:nowrap}.head h1{font-family:'Iowan Old Style',Georgia,serif;font-weight:500;font-size:1.6rem;margin:0}.nav a{color:var(--muted);text-decoration:none;font-size:.85rem;margin-left:10px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:12px;box-shadow:0 1px 2px rgba(0,0,0,.03)}
h2{font-size:.72rem;letter-spacing:.09em;text-transform:uppercase;color:var(--terra);margin:0 0 6px;display:flex;justify-content:space-between;align-items:center}h2 .n{font-weight:500;color:var(--muted);letter-spacing:0;text-transform:none}
h3{font-size:.9rem;margin:10px 0 2px;display:flex;gap:8px;align-items:center}h3 .n{font-size:.7rem;background:var(--sand);border-radius:999px;padding:1px 8px;color:var(--muted)}h3.warn{color:#9a3412}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--line);font-size:.92rem}.row>div:first-child{min-width:0;flex:1}.row b{display:block;overflow-wrap:anywhere}.row:first-of-type,h3+.row{border-top:0}.row b{font-weight:600}.sub{font-size:.78rem;color:var(--muted);margin-top:2px;line-height:1.4}
a.row.link{text-decoration:none;color:inherit}
.chip{flex:none;font-size:.66rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--sand);color:var(--ink);white-space:nowrap}.chip.ok{background:#e2ede0;color:#2f5d34}.chip.warn{background:#fde8e1;color:#9a3412}.chip.muted{background:#eeeae3;color:var(--muted)}
.empty{font-size:.85rem;color:var(--muted);padding:6px 0}
.day{display:flex;gap:10px;padding:7px 0;border-top:1px solid var(--line);align-items:flex-start}.day:first-child{border-top:0}.dl{flex:none;width:76px;font-size:.8rem;font-weight:600}.dd{display:flex;flex-wrap:wrap;gap:5px;align-items:center}.dd .chip{text-transform:none;letter-spacing:0;font-weight:600}
.foot{font-size:.72rem;color:var(--muted);text-align:center;margin-top:18px}
</style></head><body>
<div class="brand"><div class="mark">S</div><div class="wm">Samba · Era's day</div></div>
<div class="head"><h1>${esc(b.label)}</h1><div class="nav"><a href="?d=${prev}">‹ ${esc(prev.slice(5))}</a><a href="?d=${next}">${esc(next.slice(5))} ›</a></div></div>
${section('Guests', guestsHtml)}
${section('Cleaning', cleaningHtml, `<span class="n">${(b.cleaning || []).reduce((n, p) => n + p.visits.length, 0)} visits</span>`)}
${tukangHtml ? section('Tukang visits', tukangHtml) : ''}
${section('Waiting on you', backlogHtml + relaysHtml + viewingsHtml, `<span class="n">${(b.backlog || []).length + (b.relays || []).length}</span>`)}
${looseHtml ? section('Yesterday, still open', looseHtml) : ''}
${section('The week', weekHtml + moneyHtml)}
<div class="foot">Built ${esc(new Date(b.generated_at || Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit' }))} WITA from the booking calendar and the schedule · <a href="https://sambarentals.com/payouts#/cleaning">Open the Schedule page</a></div>
</body></html>`;
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
      ...(tok.aud === 'owner' ? [] : [['Housekeeper', rec.staff || 'Unknown']]),
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

