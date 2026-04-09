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

  const { period = '7d' } = req.query;

  async function get(key) {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return parseInt(d.result || 0);
  }

  async function mget(keys) {
    if (!keys.length) return [];
    const r = await fetch(`${url}/mget/${keys.map(k => encodeURIComponent(k)).join('/')}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return (d.result || []).map(v => parseInt(v || 0));
  }

  async function lrange(key, start, end) {
    const r = await fetch(`${url}/lrange/${encodeURIComponent(key)}/${start}/${end}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    return (d.result || []).map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean);
  }

  // Build date ranges
  const days = getDays(period);
  const months = getMonths(period);

  const events = ['page_view', 'details_open', 'share', 'whatsapp_click', 'photo_view', 'refresh'];
  const propIds = [11621510,11621511,11621512,11621513,11621507,11621509,12552236,12484483,12450063,12566585,12566586,12606732,12566587,12566588];
  const propNames = {
    11621510:'HAUS Unit 1',11621511:'HAUS Unit 2',11621512:'HAUS Unit 4',11621513:'HAUS Unit 5',
    11621507:'LaneHAUS Unit 1',11621509:'LaneHAUS Unit 3',
    12552236:'Villa Saturno',
    12484483:'Tropicana A4',12450063:'Tropicana A5',
    12566585:'Tropicana B2',12566586:'Tropicana B3',12606732:'Tropicana B4',
    12566587:'Tropicana B5',12566588:'Tropicana B6'
  };

  // ── TOTALS ──
  const totalKeys = events.map(e => `total:${e}`);
  totalKeys.push('total:sessions');
  const totalVals = await mget(totalKeys);
  const totals = {};
  [...events, 'sessions'].forEach((e, i) => totals[e] = totalVals[i]);

  // ── DAILY SERIES (for chart) ──
  const seriesKeys = [];
  for (const day of days) {
    seriesKeys.push(`day:${day}:page_view`);
    seriesKeys.push(`day:${day}:details_open`);
    seriesKeys.push(`day:${day}:share`);
    seriesKeys.push(`day:${day}:whatsapp_click`);
    seriesKeys.push(`day:${day}:sessions`);
  }
  const seriesVals = await mget(seriesKeys);
  const series = days.map((day, i) => ({
    date: day,
    page_view: seriesVals[i * 5],
    details_open: seriesVals[i * 5 + 1],
    share: seriesVals[i * 5 + 2],
    whatsapp_click: seriesVals[i * 5 + 3],
    sessions: seriesVals[i * 5 + 4],
  }));

  // ── PROPERTY STATS ──
  const propKeys = [];
  for (const id of propIds) {
    propKeys.push(`prop:${id}:page_view`);
    propKeys.push(`prop:${id}:details_open`);
    propKeys.push(`prop:${id}:share`);
    propKeys.push(`prop:${id}:whatsapp_click`);
  }
  const propVals = await mget(propKeys);
  const properties = propIds.map((id, i) => ({
    id, name: propNames[id],
    views: propVals[i * 4],
    details: propVals[i * 4 + 1],
    shares: propVals[i * 4 + 2],
    whatsapp: propVals[i * 4 + 3],
  })).sort((a, b) => b.views - a.views);

  // ── RECENT EVENTS ──
  const recent = await lrange('events:recent', 0, 49);

  return res.status(200).json({ totals, series, properties, recent, period, days });
}

function getDays(period) {
  const days = [];
  const n = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }
  return days;
}

function getMonths(period) {
  const months = [];
  const n = period === '7d' ? 1 : period === '30d' ? 1 : 3;
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setMonth(d.getMonth() - i);
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}
