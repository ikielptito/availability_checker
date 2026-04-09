export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  const { event, propId, propName, agentId } = req.body || {};
  if (!event) return res.status(400).json({ error: 'Missing event' });

  const now = Date.now();
  const day = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const week = getWeek();
  const month = day.slice(0, 7); // YYYY-MM

  async function incr(key) {
    await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  async function lpush(key, value) {
    await fetch(`${url}/lpush/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    // Keep only last 1000 events
    await fetch(`${url}/ltrim/${encodeURIComponent(key)}/0/999`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  const keys = [];

  // Global counters
  keys.push(incr(`total:${event}`));
  keys.push(incr(`day:${day}:${event}`));
  keys.push(incr(`week:${week}:${event}`));
  keys.push(incr(`month:${month}:${event}`));

  // Session tracking (page_view = new session indicator)
  if (event === 'page_view') {
    keys.push(incr(`day:${day}:sessions`));
    keys.push(incr(`week:${week}:sessions`));
    keys.push(incr(`month:${month}:sessions`));
    keys.push(incr(`total:sessions`));
  }

  // Property-level counters
  if (propId) {
    keys.push(incr(`prop:${propId}:${event}`));
    keys.push(incr(`prop:${propId}:day:${day}:${event}`));
    keys.push(incr(`prop:${propId}:month:${month}:${event}`));
  }
if (agentId) {
    await fetch(`${url}/sadd/unique:agents:${day}/${encodeURIComponent(agentId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });
    await fetch(`${url}/sadd/unique:agents:all/${encodeURIComponent(agentId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });
  }
  // Recent event log
  keys.push(lpush('events:recent', { event, propId, propName, ts: now, day }));

  await Promise.all(keys);

  return res.status(200).json({ ok: true });
}

function getWeek() {
  const d = new Date();
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
}
