// Maintenance — the portal side. Same three-realm shape as api/statements.js:
//
//   POST { action, payload }        admin proxy (Bearer <admin password>, or
//     Era's scoped STATEMENTS_ADMIN_PASSWORD) → forwards maint_* actions to
//     the CRM with LISTING_SYNC_SECRET, which never reaches the browser.
//
//   GET  ?action=items              owner session (or an admin preview token)
//     — the owner's maintenance items for the portal's Maintenance tab.
//
//   GET  ?action=public&token=      no login — the /m/<token> page's data.
//   POST { action: 'decide' }       approve/decline, authorised by that same
//     signed token OR by the owner's session.

import { verifyMaintenanceToken, verifyPreviewToken, verifyTukangToken } from '../lib/tokens.js';
import { UNITS_BY_SLUG } from '../lib/catalog.js';
import { loadHostexOwnerMap } from '../lib/owner-listings.js';

const SESSION_COOKIE = 'samba_session';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const sync = process.env.LISTING_SYNC_SECRET;
  const crm = async (action, payload) => {
    const r = await fetch(`${crmBase}/api/maintenance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    return { status: r.status, body };
  };
  // Statement groups live behind the statements router.
  const crmStatements = async (action, payload) => {
    const r = await fetch(`${crmBase}/api/statements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload }),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

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

  const adminPasswords = () => [
    process.env.DASHBOARD_PASSWORD, process.env.ADMIN_PASSWORD,
    process.env.STATEMENTS_ADMIN_PASSWORD,      // Era's scoped credential
  ].filter(Boolean);

  try {
    // ── POST ────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { action, payload } = req.body || {};

      // Owner decision: approve or decline. Either the signed link from
      // Maya, or the owner's own session — an approval authorises spending,
      // so it must be one of those two, never an unauthenticated call.
      if (action === 'decide') {
        const parsed = verifyMaintenanceToken(payload?.token || '');
        let groupKey = parsed?.groupKey || null;
        let itemId = parsed?.id ?? null;
        let by = 'owner (link)';

        if (!parsed) {
          const owner = await sessionOwner(req, kvGet);
          if (!owner) return res.status(401).json({ error: 'Not signed in' });
          const groups = await ownerGroups(owner, kvGet, crmStatements);
          itemId = parseInt(payload?.id, 10);
          const detail = await crm('maint_detail', { id: itemId });
          const g = detail.body?.item?.group_key;
          if (!g || !groups.some(x => x.key === g)) return res.status(403).json({ error: 'Not your property' });
          groupKey = g;
          by = owner.name || owner.email || 'owner';
        }
        if (!itemId) return res.status(400).json({ error: 'Missing item' });

        const decision = payload?.decision === 'decline' ? 'decline' : 'approve';
        const { status, body } = decision === 'approve'
          ? await crm('maint_approve', { id: itemId, by })
          : await crm('maint_decline', { id: itemId, by, note: payload?.note });
        return res.status(status).json({ ...body, decision, group_key: groupKey });
      }

      // Admin proxy — Ikiel or Era.
      const auth = req.headers.authorization || '';
      const pws = adminPasswords();
      if (!pws.length) return res.status(503).json({ error: 'Admin password not configured' });
      const isEra = process.env.STATEMENTS_ADMIN_PASSWORD && auth === `Bearer ${process.env.STATEMENTS_ADMIN_PASSWORD}`;
      if (!pws.some(p => auth === `Bearer ${p}`)) return res.status(401).json({ error: 'Unauthorized' });
      if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
      if (!/^maint_[a-z_]+$/.test(String(action || ''))) {
        return res.status(400).json({ error: `unsupported action: ${action}` });
      }
      const { status, body } = await crm(action, { ...(payload || {}), actor: isEra ? 'era' : 'admin' });
      return res.status(status).json(body);
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const action = String(req.query.action || '');

    // ── The no-login /m/<token> page ────────────────────────────────
    if (action === 'public') {
      const parsed = verifyMaintenanceToken(req.query.token || '');
      if (!parsed) return res.status(403).json({ error: 'Invalid maintenance link' });
      const { status, body } = await crm('maint_public', { group_key: parsed.groupKey, item_id: parsed.id });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }

    // ── The tukang's job sheet, /j/<token> ──────────────────────────
    // Read-only by design. The owner's /m/ link can approve spending; this
    // one can do nothing but show the tradesman what he is being asked to
    // fix, so a forwarded link is harmless.
    if (action === 'job') {
      const itemId = verifyTukangToken(req.query.token || '');
      if (!itemId) return res.status(403).json({ error: 'Link tidak berlaku' });
      const { status, body } = await crm('maint_job', { item_id: itemId });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(status).json(body);
    }

    // ── The portal's Maintenance tab ────────────────────────────────
    if (action === 'items') {
      let groups;
      const previewGroup = verifyPreviewToken(req.query.preview || '');
      if (previewGroup) {
        const gr = await crmStatements('statement_groups', {});
        groups = (gr.body?.groups || []).filter(g => g.key === previewGroup);
      } else {
        const owner = await sessionOwner(req, kvGet);
        if (!owner) return res.status(401).json({ error: 'Not signed in' });
        groups = await ownerGroups(owner, kvGet, crmStatements);
      }
      if (!groups.length) return res.status(200).json({ items: [] });
      const { body } = await crm('maint_owner_items', { group_keys: groups.map(g => g.key) });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ items: body?.items || [], ...(previewGroup ? { preview: true } : {}) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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
// Mirrors api/statements.js: catalog units this owner holds, plus (for
// WhatsApp sign-ins) groups registered to their number.
async function ownerGroups(owner, kvGet, crmStatements) {
  const hostexMap = await loadHostexOwnerMap(kvGet);
  const mySlugs = new Set(Object.values(hostexMap).filter(l => l.ownerSub === owner.sub || (l.coOwnerSubs || []).includes(owner.sub)).map(l => l.slug));
  const wa = owner.wa ? String(owner.wa).replace(/\D/g, '') : null;
  if (!mySlugs.size && !wa) return [];
  const gr = await crmStatements('statement_groups', {});
  return (gr.body?.groups || []).filter(g =>
    (g.listing_slugs || []).some(s => mySlugs.has(s))
    || (wa && (g.owner_wa_nums || []).some(n => String(n).replace(/\D/g, '') === wa)));
}
