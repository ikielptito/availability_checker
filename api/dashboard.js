export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Per-agent funnel for the CRM (sync-secret auth, not the dashboard pwd) ──
  // Folded here to stay under Vercel Hobby's 12-function cap. Returns per CRM
  // agent id: clicks/enquiries/last-seen + channel totals, for the CRM to join
  // with message read-rates into the sent→read→clicked→enquired funnel.
  if (req.query.agent_funnel === '1') {
    const secret = process.env.LISTING_SYNC_SECRET;
    if (secret && (req.headers.authorization || '') !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return handleAgentFunnel(req, res);
  }

  // Password check (shared between analytics GET and notify-agents POST).
  // Accept ADMIN_PASSWORD too so the unified /admin console's single login
  // works for the embedded analytics tab regardless of which env var is set.
  const auth = req.headers.authorization || '';
  const pwd = process.env.DASHBOARD_PASSWORD || 'samba2024';
  const adminPwd = process.env.ADMIN_PASSWORD || '';
  if (auth !== `Bearer ${pwd}` && !(adminPwd && auth === `Bearer ${adminPwd}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── POST → notify-agents (manual broadcast preview/fire) ──────────
  // Folded into this handler to stay under Vercel Hobby plan's 12-function
  // cap. Body: { mode: 'autopilot' | 'silent', preview: boolean }.
  if (req.method === 'POST') return handleNotifyAgents(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  // Recent captured errors (from lib/errlog.js) for the admin console.
  if (req.query.errors === '1') {
    try {
      const r = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([['LRANGE', 'errors:recent', '0', '199']]),
      });
      const d = await r.json();
      const raw = (Array.isArray(d) ? d[0]?.result : null) || [];
      const errors = raw.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
      return res.status(200).json({ errors });
    } catch (e) {
      return res.status(502).json({ error: 'Could not read errors', detail: e.message });
    }
  }

  const period = ['today', '7d', '30d', '90d', 'all'].includes(req.query.period) ? req.query.period : '7d';
  const nDays = period === 'today' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 90;
  const days = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  async function pipeline(cmds) {
    const out = [];
    for (let i = 0; i < cmds.length; i += 400) {
      const chunk = cmds.slice(i, i + 400);
      const r = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk),
      });
      const d = await r.json();
      if (!Array.isArray(d)) throw new Error('Pipeline failed');
      out.push(...d.map(x => x.result));
    }
    return out;
  }

  // Property list comes from the listings API so custom properties show up automatically
  let listingProps = [];
  try {
    const lr = await fetch(`https://${req.headers.host}/api/listings`);
    const { listings } = await lr.json();
    listingProps = (listings || []).map(l => ({
      id: l.custom ? 'c_' + l.slug : String(l.hostexId),
      name: l.name,
      custom: !!l.custom,
    }));
  } catch {}

  const EVENTS = ['page_view', 'listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download', 'refresh', 'sessions', 'eng_sessions', 'wa_sessions'];
  const PEVENTS = ['listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download'];

  const cmds = [];
  EVENTS.forEach(e => cmds.push(['GET', `total:${e}`]));
  days.forEach(d => EVENTS.forEach(e => cmds.push(['GET', `day:${d}:${e}`])));
  days.forEach(d => cmds.push(['SCARD', `unique:agents:${d}`]));
  cmds.push(['SUNION', ...days.map(d => `unique:agents:${d}`)]);
  cmds.push(['SCARD', 'unique:agents:all']);
  listingProps.forEach(p => PEVENTS.forEach(e => cmds.push(['GET', `prop:${p.id}:${e}`])));
  days.forEach(d => cmds.push(['HGETALL', `pstats:${d}`]));
  const curMonth = new Date().toISOString().slice(0, 7);
  cmds.push(['HGETALL', 'attr:views'], ['HGETALL', 'attr:wa'],
            ['HGETALL', `attr:views:${curMonth}`], ['HGETALL', `attr:wa:${curMonth}`]);
  cmds.push(['LRANGE', 'events:recent', '0', '49']);

  const out = await pipeline(cmds);
  let ptr = 0;
  const num = v => parseInt(v) || 0;

  const allTotals = {};
  EVENTS.forEach(e => allTotals[e] = num(out[ptr++]));
  const dayGrid = days.map(() => {
    const o = {};
    EVENTS.forEach(e => o[e] = num(out[ptr++]));
    return o;
  });
  const agentsPerDay = days.map(() => num(out[ptr++]));
  const unionAgents = out[ptr++];
  const uniqueAgentsPeriod = Array.isArray(unionAgents) ? unionAgents.length : 0;
  const uniqueAgentsAll = num(out[ptr++]);
  const lifetimeProps = listingProps.map(() => {
    const o = {};
    PEVENTS.forEach(e => o[e] = num(out[ptr++]));
    return o;
  });
  const pstatsDays = days.map(() => out[ptr++]);
  const hashToObj = h => {
    const o = {};
    if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) o[h[i]] = num(h[i + 1]);
    return o;
  };
  const attribution = {
    views_all: hashToObj(out[ptr++]), wa_all: hashToObj(out[ptr++]),
    views_month: hashToObj(out[ptr++]), wa_month: hashToObj(out[ptr++]),
  };
  const recentRaw = out[ptr++] || [];

  // Totals for the selected period (all-time uses lifetime counters)
  const totals = {};
  if (period === 'all') {
    EVENTS.forEach(e => totals[e] = allTotals[e]);
  } else {
    EVENTS.forEach(e => totals[e] = dayGrid.reduce((s, d) => s + d[e], 0));
  }
  totals.unique_agents = period === 'all' ? uniqueAgentsAll : uniqueAgentsPeriod;
  totals.unique_agents_today = agentsPerDay[agentsPerDay.length - 1];
  totals.unique_agents_all = uniqueAgentsAll;

  // Daily series for the chart
  const series = days.map((d, i) => ({
    date: d,
    page_view: dayGrid[i].page_view,
    listing_view: dayGrid[i].listing_view,
    details_open: dayGrid[i].details_open,
    share: dayGrid[i].share,
    whatsapp_click: dayGrid[i].whatsapp_click,
    sessions: dayGrid[i].sessions,
    agents: agentsPerDay[i],
  }));

  // Per-property stats: lifetime counters for "all", per-day hashes for periods.
  // Note: per-day hashes only exist from the date this tracking was deployed.
  const propMap = {};
  listingProps.forEach((p, i) => {
    propMap[p.id] = { id: p.id, name: p.name, custom: p.custom, ...(period === 'all' ? lifetimeProps[i] : Object.fromEntries(PEVENTS.map(e => [e, 0]))) };
  });
  if (period !== 'all') {
    pstatsDays.forEach(h => {
      if (!Array.isArray(h)) return;
      for (let i = 0; i < h.length; i += 2) {
        const field = h[i];
        const idx = field.lastIndexOf(':');
        if (idx < 0) continue;
        const pid = field.slice(0, idx);
        const ev = field.slice(idx + 1);
        if (propMap[pid] && PEVENTS.includes(ev)) propMap[pid][ev] += num(h[i + 1]);
      }
    });
  }
  const properties = Object.values(propMap)
    .map(p => ({ ...p, engagement: p.listing_view + p.details_open }))
    .sort((a, b) => b.engagement - a.engagement);

  const recent = recentRaw.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);

  // ── Signed-up agents (real Google accounts, not device-tracked visitors) ──
  // The "unique agents" counters above come from anonymous visit tracking. These
  // are actual portal accounts created via Google sign-in (owner:{sub} records).
  // No index set exists, so SCAN the keyspace — signups are small (tens), and
  // this endpoint is admin-only and infrequent, so the scan cost is negligible.
  let signups = { count: 0, recent: [] };
  try {
    const ownerKeys = [];
    let cursor = '0';
    do {
      const sr = await fetch(`${url}/scan/${cursor}?match=${encodeURIComponent('owner:*')}&count=500`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const sd = await sr.json();
      const [next, batch] = Array.isArray(sd.result) ? sd.result : ['0', []];
      cursor = next;
      (batch || []).forEach(k => ownerKeys.push(k));
    } while (cursor && cursor !== '0');

    if (ownerKeys.length) {
      const vals = await pipeline(ownerKeys.map(k => ['GET', k]));
      const owners = vals
        .map(v => { try { return JSON.parse(v); } catch { return null; } })
        .filter(Boolean);
      owners.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      const newInPeriod = period === 'all'
        ? owners.length
        : owners.filter(o => o.createdAt && days.includes(o.createdAt.split('T')[0])).length;
      signups = {
        count: owners.length,
        newInPeriod,
        recent: owners.slice(0, 25).map(o => ({
          name: o.name || o.email || 'Agent',
          email: o.email || '',
          picture: o.picture || '',
          createdAt: o.createdAt || null,
          favorites: Array.isArray(o.favorites) ? o.favorites.length : 0,
          lists: Array.isArray(o.lists) ? o.lists.length : 0,
          handle: (o.profile && o.profile.handle) || null,
        })),
      };
    }
  } catch {}

  return res.status(200).json({ period, days, totals, allTotals, series, properties, recent, attribution, signups });
}

// ── Manual broadcast: preview or fire ───────────────────────────────
// Originally api/notify-agents.js — folded in here to stay under Vercel
// Hobby plan's 12-function cap.
async function handleNotifyAgents(req, res) {
  const { mode = 'autopilot', preview = false } = req.body || {};
  if (!['autopilot', 'silent'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "autopilot" or "silent"' });
  }

  const crmBase = process.env.CRM_BASE_URL || 'https://kaya-agent-crm.vercel.app';

  // ── PREVIEW MODE ────────────────────────────────────────────────
  if (preview) {
    const cronRes = await fetch(`${crmBase}/api/cron-followups?preview=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const cronBody = await cronRes.json().catch(() => ({}));
    const av = cronBody.availability || {};
    return res.status(200).json({
      ok: true,
      preview: true,
      mode,
      now_utc: new Date().toISOString(),
      recipients: av.recipients || 0,
      enabled: av.enabled,
      template_version: av.template_version,
      preview_data: av.preview || null,
      enabled_warning: av.enabled === false ? 'Broadcast switch is off (samba_availability.enabled = false). Preview shown without writing.' : null,
    });
  }

  // ── Step 1: digest from KV cache (no self-call → no deadlock) ───
  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  const kvRes = await fetch(`${kvUrl}/get/${encodeURIComponent('digest:cache')}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });
  const kvJson = await kvRes.json();
  let digest = null;
  try { digest = JSON.parse(kvJson.result); } catch {}
  if (!digest || !digest.properties) {
    return res.status(503).json({
      error: 'No digest available — visit /api/digest first to warm the cache',
    });
  }
  const propCount = digest.properties.length;

  // ── Step 2: build "all unavailable yesterday" snapshot ──────────
  const flippedSnapshot = {};
  for (const p of digest.properties || []) {
    flippedSnapshot[p.id] = {
      availableToday: false,
      nextLongWindowFrom: null,
      monthly: p.monthly || null,
    };
  }

  // ── Step 3: stage CRM settings before the trigger ───────────────
  async function crmSet(key, value) {
    const r = await fetch(`${crmBase}/api/supabase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_settings', payload: { key, value } }),
    });
    return r.ok;
  }
  const settingsOk = await Promise.all([
    crmSet('samba_availability', { enabled: true, test_agents_only: false }),
    crmSet('samba_availability_snapshot', flippedSnapshot),
    crmSet('automation', { mode: mode === 'autopilot' ? 'autopilot' : 'off' }),
  ]);
  if (!settingsOk.every(Boolean)) {
    return res.status(502).json({ error: 'CRM settings update failed', settingsOk });
  }

  // ── Step 4: fire the CRM cron ───────────────────────────────────
  const cronRes = await fetch(`${crmBase}/api/cron-followups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const cronBody = await cronRes.json().catch(() => ({}));

  return res.status(200).json({
    ok: true,
    triggered_at: new Date().toISOString(),
    mode,
    properties_in_digest: propCount,
    snapshot_entries_written: Object.keys(flippedSnapshot).length,
    cron_response: cronBody.availability || cronBody,
  });
}

// Per-agent portal engagement for the CRM funnel join. Reads the durable
// per-agent counters written by api/track.js (agent:{aid}:events / :last_seen)
// plus channel totals. Auth is checked by the caller (sync-secret).
async function handleAgentFunnel(req, res) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });
  const kv = async (cmds) => {
    const r = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
    });
    return r.json();
  };
  try {
    const membersRes = await fetch(`${url}/smembers/unique:agents:all`, { headers: { Authorization: `Bearer ${token}` } });
    const members = (await membersRes.json())?.result || [];
    const aids = members.filter(a => /^\d{1,12}$/.test(String(a)));
    const agents = {};
    if (aids.length) {
      const cmds = [];
      aids.forEach(aid => { cmds.push(['HGETALL', `agent:${aid}:events`], ['GET', `agent:${aid}:last_seen`]); });
      const results = await kv(cmds);
      const toObj = (arr) => { const o = {}; if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0; return o; };
      aids.forEach((aid, i) => {
        const ev = toObj(results[i * 2]?.result);
        const lastSeen = results[i * 2 + 1]?.result;
        const clicks = (ev.listing_view || 0) + (ev.details_open || 0) + (ev.photo_view || 0);
        const enquiries = ev.whatsapp_click || 0;
        if (clicks || enquiries || lastSeen) agents[aid] = { clicks, enquiries, page_views: ev.page_view || 0, last_seen: lastSeen ? Number(lastSeen) : null };
      });
    }
    const today = new Date().toISOString().split('T')[0];
    let channels = {};
    try {
      const ch = await kv([
        ['GET', 'total:src:wa_alert'], ['GET', 'total:src:wa_digest'],
        ['GET', `day:${today}:src:wa_alert`], ['GET', `day:${today}:src:wa_digest`],
      ]);
      channels = {
        wa_alert_all: Number(ch[0]?.result) || 0, wa_digest_all: Number(ch[1]?.result) || 0,
        wa_alert_today: Number(ch[2]?.result) || 0, wa_digest_today: Number(ch[3]?.result) || 0,
      };
    } catch { /* best-effort */ }
    return res.status(200).json({ agents, count: Object.keys(agents).length, channels });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
