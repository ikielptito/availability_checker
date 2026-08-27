// Owner statements — the portal side. Three auth realms in one function:
//
//   POST { action, payload }            admin proxy (Authorization: Bearer
//     <admin password>) — forwards statement_* actions verbatim to the CRM's
//     /api/statements with LISTING_SYNC_SECRET (server-side only; the secret
//     never reaches the browser). Same stance as api/campaigns.js: no
//     password configured → 503, never open.
//
//   GET ?action=statements              owner session (samba_session cookie)
//     — the signed-in owner's published/paid statements, scoped to the
//     catalog units whose listing override carries their ownerSub.
//
//   GET ?action=public-statement&token= no login — the /st/<token> page's
//     data. The signed period-scoped token IS the auth (lib/tokens.js).
//
//   GET ?action=month-stats&slugs=&period=   service auth (sync secret) —
//     Hostex month aggregates the CRM snapshots into a statement at publish.

import { verifyStatementToken, statementToken, inviteToken, verifyInviteToken, previewToken, verifyPreviewToken } from '../lib/tokens.js';
import { buildMonthStats, buildRangeStats, applyStatementNights } from '../lib/month-stats.js';
import { buildStatementWorkbook, buildGroupWorkbook } from '../lib/statement-export.js';
import { UNITS_BY_SLUG } from '../lib/catalog.js';
import { loadHostexOwnerMap } from '../lib/owner-listings.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SESSION_COOKIE = 'samba_session';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const sync = process.env.LISTING_SYNC_SECRET;
  const crm = async (action, payload) => {
    const r = await fetch(`${crmBase}/api/statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    return { status: r.status, body };
  };

  // KV via the Upstash REST pipeline — the same call shape the rest of the
  // codebase uses (and the only one dev/devserver.mjs's mock intercepts).
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  const kvGet = async (key) => {
    if (!kvUrl || !kvToken) return null;
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['GET', key]]),
    });
    const out = await r.json().catch(() => null);
    const raw = Array.isArray(out) ? out[0]?.result : null;
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  };

  const kvSet = async (key, value) => {
    if (!kvUrl || !kvToken) return false;
    const r = await fetch(`${kvUrl}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['SET', key, JSON.stringify(value)]]),
    });
    const out = await r.json().catch(() => null);
    return Array.isArray(out) && out[0]?.result === 'OK';
  };

  // ── POST ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};

    // Owner-onboarding invite: the signed link Ikiel sends on WhatsApp. The
    // owner opens it, signs in with ANY Google account, and this claims the
    // group's catalog listings to that account — one-shot: refused when a
    // different account already holds any of the units.
    if (action === 'claim_invite') {
      const owner = await sessionOwner(req, kvGet);
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const groupKey = verifyInviteToken(payload?.token || '');
      if (!groupKey) return res.status(403).json({ error: 'Invalid invite link' });
      const groupsRes = await crm('statement_groups', {});
      const group = (groupsRes.body?.groups || []).find(g => g.key === groupKey);
      if (!group) return res.status(404).json({ error: 'Unknown property' });
      const slugs = (group.listing_slugs || []).filter(s => UNITS_BY_SLUG[s]);
      if (!slugs.length) return res.status(404).json({ error: 'No claimable listings' });
      const overrides = await Promise.all(slugs.map(s => kvGet(`listing:${s}`)));
      for (let i = 0; i < slugs.length; i++) {
        const cur = overrides[i] || {};
        if (cur.ownerSub && cur.ownerSub !== owner.sub) {
          return res.status(409).json({ error: `${UNITS_BY_SLUG[slugs[i]].name} is already linked to another account — ask Samba to sort it out.` });
        }
      }
      for (let i = 0; i < slugs.length; i++) {
        const cur = overrides[i] || { slug: slugs[i] };
        await kvSet(`listing:${slugs[i]}`, {
          ...cur, slug: slugs[i],
          ownerSub: owner.sub,
          ownerEmail: (owner.email || cur.ownerEmail || '').toLowerCase() || null,
          updatedAt: Date.now(),
        });
      }
      return res.status(200).json({ ok: true, group: group.name, listings: slugs.map(s => UNITS_BY_SLUG[s].name) });
    }

    // Owner-session realm: the signed-in owner saves their preferred payout
    // account for one of THEIR property groups. The server forwards only the
    // payout_account field — never the notify/number registry fields.
    if (action === 'payout_account') {
      const owner = await sessionOwner(req, kvGet);
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const groupKey = String(payload?.group_key || '');
      const myGroups = await ownerGroups(owner, kvGet, crm);
      if (!myGroups.some(g => g.key === groupKey)) return res.status(403).json({ error: 'Not your property' });
      try {
        const { status, body } = await crm('statement_group_patch', {
          key: groupKey, actor: 'owner',
          fields: { payout_account: payload?.account || null },
        });
        return res.status(status).json(body);
      } catch (e) {
        return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
      }
    }

    // Admin realm: forward statement_* actions to the CRM verbatim.
    const auth = req.headers.authorization || '';
    const pwd = process.env.DASHBOARD_PASSWORD || '';
    const adminPwd = process.env.ADMIN_PASSWORD || '';
    if (!pwd && !adminPwd) return res.status(503).json({ error: 'Admin password not configured' });
    if (!(pwd && auth === `Bearer ${pwd}`) && !(adminPwd && auth === `Bearer ${adminPwd}`)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
    if (!/^statement_[a-z_]+$/.test(String(action || ''))) {
      return res.status(400).json({ error: `unsupported action: ${action}` });
    }
    try {
      const { status, body } = await crm(action, { ...(payload || {}), actor: 'admin' });
      return res.status(status).json(body);
    } catch (e) {
      return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
    }
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const action = String(req.query.action || '');
  try {
    // ── Hostex month aggregates (service auth) ──────────────────────
    if (action === 'month-stats') {
      if (!sync || (req.headers.authorization || '') !== `Bearer ${sync}`) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const period = String(req.query.period || '');
      if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ error: 'period must be YYYY-MM' });
      const units = String(req.query.slugs || '').split(',').map(s => s.trim()).filter(Boolean)
        .map(slug => ({ slug, hostexId: UNITS_BY_SLUG[slug]?.hostexId || null, name: UNITS_BY_SLUG[slug]?.name || null }));
      if (!units.length) return res.status(400).json({ error: 'Missing slugs' });
      const stats = await buildMonthStats(units, period);
      // The CRM sends Era's recorded guest nights so direct rentals the
      // calendar never saw count as occupied.
      try { if (req.query.stmt_nights) applyStatementNights(stats, JSON.parse(String(req.query.stmt_nights))); } catch { /* best-effort */ }
      return res.status(200).json(stats);
    }

    // ── Public tokenized statement (no login) ───────────────────────
    if (action === 'public-statement') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const { status, body } = await crm('statement_public', { group_key: parsed.groupKey, period: parsed.period });
      // Reference FX rates for the page's currency picker — best-effort:
      // the statement renders fine without them (picker just stays hidden).
      if (status === 200) { try { body.fx = await getFx(); } catch { /* best-effort */ } }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }

    // ── Live timeframe stats for a statement's property group ───────
    // Authorized by the statement token (occupancy/nights only — the same
    // audience that can already see the month's full financials). The month
    // view stays the frozen snapshot; quarter/year/next are computed LIVE
    // from Hostex relative to the statement's period.
    if (action === 'stats') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const range = String(req.query.range || 'quarter');
      const [y, m] = parsed.period.split('-').map(Number);
      let from, to, label;
      if (range === 'year') {
        from = `${y}-01`; to = `${y}-12`; label = String(y);
      } else if (range === 'next') {
        const d = new Date(Date.UTC(y, m, 1));
        from = to = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      } else {
        const q = Math.floor((m - 1) / 3);
        from = `${y}-${String(q * 3 + 1).padStart(2, '0')}`;
        to = `${y}-${String(q * 3 + 3).padStart(2, '0')}`;
        label = `Q${q + 1} ${y}`;
      }
      const groupsRes = await crm('statement_groups', {});
      const group = (groupsRes.body?.groups || []).find(g => g.key === parsed.groupKey);
      if (!group) return res.status(404).json({ error: 'Unknown group' });
      const units = (group.listing_slugs || [])
        .map(slug => ({ slug, hostexId: UNITS_BY_SLUG[slug]?.hostexId || null, name: UNITS_BY_SLUG[slug]?.name || null }));
      const stats = await buildRangeStats(units, { from, to });
      // Count Era-recorded direct rentals as occupied nights (live views).
      try {
        const un = await crm('statement_unit_nights', { group_key: parsed.groupKey, from, to });
        if (un.status === 200) applyStatementNights(stats, un.body);
      } catch { /* best-effort */ }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ range, from, to, label, ...stats });
    }

    // ── Signed-in owner's statements (portal tab) ───────────────────
    // Also serves the admin's read-only preview: a signed preview token
    // scopes the response to one group, exactly as its owner will see it.
    if (action === 'statements') {
      let groups;
      const previewGroup = verifyPreviewToken(req.query.preview || '');
      if (previewGroup) {
        const groupsRes = await crm('statement_groups', {});
        groups = (groupsRes.body?.groups || []).filter(g => g.key === previewGroup);
      } else {
        const owner = await sessionOwner(req, kvGet);
        if (!owner) return res.status(401).json({ error: 'Not signed in' });
        groups = await ownerGroups(owner, kvGet, crm);
      }
      if (!groups.length) return res.status(200).json({ statements: [], groups: [] });

      const listRes = await crm('statement_list', {});
      const mine = (listRes.body?.statements || [])
        .filter(s => ['published', 'partial', 'paid'].includes(s.status) && groups.some(g => g.key === s.group_key))
        .map(s => ({
          group_key: s.group_key,
          group_name: s.statement_groups?.name || s.group_key,
          period: s.period,
          status: s.status,
          payout_total: s.payout_total,
          paid_total: s.paid_total,
          balance: Math.max(0, (Number(s.payout_total) || 0) - (Number(s.paid_total) || 0)),
          currency: s.currency,
          published_at: s.published_at,
          paid_at: s.paid_at,
          // Safe to hand this owner the signed link — they're authorized for
          // the group; the token just lets them open/share the no-login page.
          url: `/st/${statementToken(s.group_key, s.period)}`,
        }));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        statements: mine,
        groups: groups.map(g => ({ key: g.key, name: g.name, owner_names: g.owner_names || null, payout_account: g.payout_account || null })),
        ...(previewGroup ? { preview: true } : {}),
      });
    }

    // ── Admin read-only portal preview link ─────────────────────────
    if (action === 'preview-link') {
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const groupKey = String(req.query.group || '');
      if (!groupKey) return res.status(400).json({ error: 'Missing group' });
      return res.status(200).json({ url: `https://sambarentals.com/portal?preview=${previewToken(groupKey)}` });
    }

    // ── Owner invite link (admin) ───────────────────────────────────
    if (action === 'invite-link') {
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      if (!isAdmin) return res.status(401).json({ error: 'Unauthorized' });
      const groupKey = String(req.query.group || '');
      if (!groupKey) return res.status(400).json({ error: 'Missing group' });
      return res.status(200).json({ url: `https://sambarentals.com/portal?invite=${inviteToken(groupKey)}` });
    }

    // ── Excel exports ───────────────────────────────────────────────
    // One month, no login — the statement token IS the auth (same rule as
    // the /st/ page itself).
    if (action === 'export') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const { status, body } = await crm('statement_public', { group_key: parsed.groupKey, period: parsed.period });
      if (status !== 200) return res.status(status).json(body);
      return sendXlsx(res, buildStatementWorkbook(body), `Samba-Statement-${parsed.groupKey}-${parsed.period}.xlsx`);
    }
    // Whole group, banking-statement style: pick a month range (or all) and
    // get ONE consolidated workbook. Owner session or admin password.
    if (action === 'export-group') {
      const groupKey = String(req.query.group || '');
      const year = String(req.query.year || '').replace(/\D/g, '').slice(0, 4) || null;
      const from = /^\d{4}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : null;
      const to = /^\d{4}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : null;
      const auth = req.headers.authorization || '';
      const isAdmin = [process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD].filter(Boolean).some(p => auth === `Bearer ${p}`);
      const previewOk = verifyPreviewToken(req.query.preview || '') === groupKey;
      if (!isAdmin && !previewOk) {
        const owner = await sessionOwner(req, kvGet);
        const groups = owner ? await ownerGroups(owner, kvGet, crm) : [];
        if (!groups.some(g => g.key === groupKey)) return res.status(owner ? 403 : 401).json({ error: owner ? 'Not your property' : 'Not signed in' });
      }
      const { status, body } = await crm('statement_export_data', { group_key: groupKey, year, from, to });
      if (status !== 200) return res.status(status).json(body);
      const mlab = (p) => { const [y, m] = p.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
      const rangeLabel = from || to ? `${from ? mlab(from) : 'start'} – ${to ? mlab(to) : 'latest'}` : year;
      const suffix = from || to ? `-${from || 'start'}-to-${to || 'latest'}` : year ? '-' + year : '';
      return sendXlsx(res, buildGroupWorkbook(body, rangeLabel), `Samba-Financials-${groupKey}${suffix}.xlsx`);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Daily-ish IDR reference rates (open.er-api.com — keyless, generous limits),
// cached for the lambda's lifetime. Display convenience ONLY: every payout is
// made in IDR and the page says so whenever a conversion is shown.
let _fx = null;
async function getFx() {
  if (_fx && Date.now() - _fx.fetched < 12 * 3600e3) return _fx.payload;
  const r = await fetch('https://open.er-api.com/v6/latest/IDR');
  const d = await r.json();
  if (d?.result !== 'success' || !d.rates) return _fx?.payload || null;
  const payload = {
    base: 'IDR',
    as_of: String(d.time_last_update_utc || '').replace(/ \d\d:.*$/, ''),
    rates: Object.fromEntries(['USD', 'EUR', 'GBP', 'AUD', 'SGD'].map(c => [c, d.rates[c]]).filter(([, v]) => v)),
  };
  _fx = { payload, fetched: Date.now() };
  return payload;
}

function sendXlsx(res, buf, filename) {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buf);
}

function readSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${SESSION_COOKIE}=`));
  return m ? decodeURIComponent(m.slice(SESSION_COOKIE.length + 1)) : null;
}

async function sessionOwner(req, kvGet) {
  const token = readSessionToken(req);
  const session = token ? await kvGet(`session:${token}`) : null;
  return session && (!session.exp || session.exp >= Date.now()) ? kvGet(`owner:${session.sub}`) : null;
}

// The statement groups whose listing_slugs include a catalog unit this owner
// owns (statement groups only ever reference catalog slugs).
async function ownerGroups(owner, kvGet, crm) {
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const mySlugs = new Set(Object.values(hostexMap).filter(l => l.ownerSub === owner.sub).map(l => l.slug));
  if (!mySlugs.size) return [];
  const groupsRes = await crm('statement_groups', {});
  return (groupsRes.body?.groups || []).filter(g => (g.listing_slugs || []).some(s => mySlugs.has(s)));
}
