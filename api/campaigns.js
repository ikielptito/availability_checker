// Campaign Command Center proxy — the admin panel's gateway to the CRM's
// campaign engine (kaya-agent-crm /api/campaigns), plus the portal-side KV
// attribution the CRM can't see (share-link visits, signup funnel, per-agent
// portal activity).
//
// Auth realms: the BROWSER talks to this function with the admin password;
// this function talks to the CRM with LISTING_SYNC_SECRET (server-side only —
// the secret never reaches the browser). Same stance as api/dashboard.js:
// no password configured → 503, never open.
//
// GET  ?view=center            → CRM campaign_center + portal attribution merge
// GET  ?view=detail&id=<uuid>  → CRM campaign_detail + per-recipient portal clicks
// POST { action, payload }     → campaign_control | audience_preview | launch_broadcast
//                                forwarded to the CRM verbatim.

// Portal ?ref= sources ↔ always-on campaign keys.
const SRC_OF_KEY = {
  availability_alert: 'wa_alert',
  availability_digest: 'wa_digest',
  account_invite: 'acct_invite',
};
const SIGNUP_SHOWN = ['gate', 'auto', 'nav', 'landing', 'handoff'].map(s => `signup_shown_${s}`);
const SIGNUP_DONE = ['gate', 'auto', 'nav', 'landing', 'handoff', 'onetap'].map(s => `signup_done_${s}`);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = req.headers.authorization || '';
  const pwd = process.env.DASHBOARD_PASSWORD || '';
  const adminPwd = process.env.ADMIN_PASSWORD || '';
  if (!pwd && !adminPwd) return res.status(503).json({ error: 'Admin password not configured' });
  if (!(pwd && auth === `Bearer ${pwd}`) && !(adminPwd && auth === `Bearer ${adminPwd}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';
  const sync = process.env.LISTING_SYNC_SECRET;
  if (!sync) return res.status(503).json({ error: 'LISTING_SYNC_SECRET not configured' });
  const crm = async (action, payload) => {
    const r = await fetch(`${crmBase}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sync}` },
      body: JSON.stringify({ action, payload }),
    });
    const body = await r.json().catch(() => ({ error: `CRM returned HTTP ${r.status}` }));
    return { status: r.status, body };
  };

  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  async function kvPipeline(cmds) {
    if (!kvUrl || !kvToken || !cmds.length) return [];
    const out = [];
    for (let i = 0; i < cmds.length; i += 400) {
      const r = await fetch(`${kvUrl}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.slice(i, i + 400)),
      });
      const d = await r.json();
      if (!Array.isArray(d)) throw new Error('KV pipeline failed');
      out.push(...d.map(x => x.result));
    }
    return out;
  }
  const lastNDays = (n) => {
    const days = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    return days;
  };

  // ── POST: control-plane forward ───────────────────────────────────
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};
    if (!['campaign_control', 'audience_preview', 'launch_broadcast'].includes(action)) {
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

  // ── GET ?view=center ──────────────────────────────────────────────
  if (req.query.view === 'center') {
    let center;
    try {
      const { status, body } = await crm('campaign_center', {});
      if (status !== 200) return res.status(status).json(body);
      center = body;
    } catch (e) {
      return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
    }
    // Portal attribution merge — best-effort: the page renders without it.
    try {
      const days30 = lastNDays(30);
      const srcs = Object.values(SRC_OF_KEY);
      const cmds = [];
      for (const s of srcs) {
        cmds.push(['GET', `total:src:${s}`]);
        for (const d of days30) cmds.push(['GET', `day:${d}:src:${s}`]);
      }
      for (const ev of [...SIGNUP_SHOWN, ...SIGNUP_DONE]) cmds.push(['GET', `total:${ev}`]);
      const out = await kvPipeline(cmds);
      let i = 0;
      const src = {};
      for (const s of srcs) {
        const total = Number(out[i++] || 0);
        let d30 = 0;
        for (let k = 0; k < days30.length; k++) d30 += Number(out[i++] || 0);
        src[s] = { total, last30: d30 };
      }
      let shown = 0, done = 0;
      for (let k = 0; k < SIGNUP_SHOWN.length; k++) shown += Number(out[i++] || 0);
      for (let k = 0; k < SIGNUP_DONE.length; k++) done += Number(out[i++] || 0);
      center.portal = { src_of_key: SRC_OF_KEY, src, signup: { shown_total: shown, done_total: done } };
    } catch { /* best-effort */ }
    return res.status(200).json(center);
  }

  // ── GET ?view=detail&id=<uuid> ────────────────────────────────────
  if (req.query.view === 'detail' && req.query.id) {
    let detail;
    try {
      const { status, body } = await crm('campaign_detail', { id: String(req.query.id) });
      if (status !== 200) return res.status(status).json(body);
      detail = body;
    } catch (e) {
      return res.status(502).json({ error: 'CRM unreachable: ' + e.message });
    }
    try {
      const key = detail.campaign?.key;
      const srcName = key && SRC_OF_KEY[key];
      const cmds = [];
      if (srcName) {
        cmds.push(['GET', `total:src:${srcName}`]);
        for (const d of lastNDays(30)) cmds.push(['GET', `day:${d}:src:${srcName}`]);
      }
      const recips = (detail.recipients || []).slice(0, 300);
      for (const r0 of recips) cmds.push(['HGETALL', `agent:${r0.id}:events`]);
      const out = await kvPipeline(cmds);
      let i = 0;
      if (srcName) {
        const total = Number(out[i++] || 0);
        let d30 = 0;
        for (let k = 0; k < 30; k++) d30 += Number(out[i++] || 0);
        detail.portal = { src: srcName, visits_total: total, visits_30d: d30 };
      }
      for (const r0 of recips) {
        const h = out[i++];
        if (Array.isArray(h) && h.length) {
          const map = {};
          for (let k = 0; k < h.length; k += 2) map[h[k]] = Number(h[k + 1] || 0);
          r0.portal_views = map.listing_view || 0;
          r0.portal_wa_clicks = map.whatsapp_click || 0;
        }
      }
    } catch { /* best-effort */ }
    return res.status(200).json(detail);
  }

  return res.status(400).json({ error: 'pass ?view=center or ?view=detail&id=<uuid>' });
}
