export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  const { event, propId, propName, agentId, newSession, src } = req.body || {};
  if (!event || !/^[a-z_]{1,32}$/.test(event)) return res.status(400).json({ error: 'Missing or invalid event' });

  const now = Date.now();
  const day = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const month = day.slice(0, 7); // YYYY-MM

  const cmds = [
    ['INCR', `total:${event}`],
    ['INCR', `day:${day}:${event}`],
    ['INCR', `month:${month}:${event}`],
  ];

  // Sessions: only counted once per browser session (frontend sends newSession flag)
  if ((event === 'page_view' || event === 'listing_view') && newSession) {
    cmds.push(
      ['INCR', 'total:sessions'],
      ['INCR', `day:${day}:sessions`],
      ['INCR', `month:${month}:sessions`]
    );
  }

  if (propId) {
    cmds.push(['INCR', `prop:${propId}:${event}`]);
    // Per-day property stats hash — powers period filtering on the dashboard
    cmds.push(['HINCRBY', `pstats:${day}`, `${propId}:${event}`, '1']);
  }

  if (agentId) {
    cmds.push(['SADD', `unique:agents:${day}`, String(agentId)]);
    cmds.push(['SADD', 'unique:agents:all', String(agentId)]);
  }

  cmds.push(['LPUSH', 'events:recent', JSON.stringify({ event, propId, propName, agentId, src, ts: now, day })]);
  cmds.push(['LTRIM', 'events:recent', '0', '999']);

  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });

  return res.status(200).json({ ok: true });
}
