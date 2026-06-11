export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Password check
  const auth = req.headers.authorization || '';
  const pwd = process.env.DASHBOARD_PASSWORD || 'samba2024';
  if (auth !== `Bearer ${pwd}`) return res.status(401).json({ error: 'Unauthorized' });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  const period = ['7d', '30d', '90d', 'all'].includes(req.query.period) ? req.query.period : '7d';
  const nDays = period === '7d' ? 7 : period === '30d' ? 30 : 90;
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

  const EVENTS = ['page_view', 'listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download', 'refresh', 'sessions'];
  const PEVENTS = ['listing_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'photo_download'];

  const cmds = [];
  EVENTS.forEach(e => cmds.push(['GET', `total:${e}`]));
  days.forEach(d => EVENTS.forEach(e => cmds.push(['GET', `day:${d}:${e}`])));
  days.forEach(d => cmds.push(['SCARD', `unique:agents:${d}`]));
  cmds.push(['SUNION', ...days.map(d => `unique:agents:${d}`)]);
  cmds.push(['SCARD', 'unique:agents:all']);
  listingProps.forEach(p => PEVENTS.forEach(e => cmds.push(['GET', `prop:${p.id}:${e}`])));
  days.forEach(d => cmds.push(['HGETALL', `pstats:${d}`]));
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

  return res.status(200).json({ period, days, totals, allTotals, series, properties, recent });
}
