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

import { verifyStatementToken, statementToken } from '../lib/tokens.js';
import { buildMonthStats } from '../lib/month-stats.js';
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

  // ── POST ──────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};

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
        .map(slug => ({ slug, hostexId: UNITS_BY_SLUG[slug]?.hostexId || null }));
      if (!units.length) return res.status(400).json({ error: 'Missing slugs' });
      return res.status(200).json(await buildMonthStats(units, period));
    }

    // ── Public tokenized statement (no login) ───────────────────────
    if (action === 'public-statement') {
      const parsed = verifyStatementToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid statement link' });
      const { status, body } = await crm('statement_public', { group_key: parsed.groupKey, period: parsed.period });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }

    // ── Signed-in owner's statements (portal tab) ───────────────────
    if (action === 'statements') {
      const owner = await sessionOwner(req, kvGet);
      if (!owner) return res.status(401).json({ error: 'Not signed in' });
      const groups = await ownerGroups(owner, kvGet, crm);
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
        groups: groups.map(g => ({ key: g.key, name: g.name, payout_account: g.payout_account || null })),
      });
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
      if (!isAdmin) {
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
