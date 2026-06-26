// One-shot backfill: rebuilds per-day property stats (pstats:{day} hashes)
// from the historical events:recent log. Old-format events lack the `src`
// field, which is what distinguishes them from events already counted by
// the new tracking — so re-running cannot double-count, and a flag key
// guards against accidental repeats anyway.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const auth = req.headers.authorization || '';
  const pwd = process.env.DASHBOARD_PASSWORD || 'samba2024';
  if (auth !== `Bearer ${pwd}`) return res.status(401).json({ error: 'Unauthorized' });

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  async function pipeline(cmds) {
    const out = [];
    for (let i = 0; i < cmds.length; i += 400) {
      const r = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(cmds.slice(i, i + 400)),
      });
      const d = await r.json();
      if (!Array.isArray(d)) throw new Error('Pipeline failed');
      out.push(...d.map(x => x.result));
    }
    return out;
  }

  const [flag, raw] = await pipeline([
    ['GET', 'pstats_backfill_done'],
    ['LRANGE', 'events:recent', '0', '999'],
  ]);
  if (flag && req.query.force !== '1') {
    return res.status(200).json({ ok: true, skipped: true, doneAt: flag });
  }

  const cmds = [];
  let backfilled = 0, scanned = 0, skippedNew = 0;
  for (const v of raw || []) {
    let e;
    try { e = JSON.parse(v); } catch { continue; }
    scanned++;
    if (e.src) { skippedNew++; continue; } // new-format event, already counted live
    if (!e.propId || !e.event || !e.day || !/^\d{4}-\d{2}-\d{2}$/.test(e.day)) continue;
    cmds.push(['HINCRBY', `pstats:${e.day}`, `${e.propId}:${e.event}`, '1']);
    backfilled++;
  }
  cmds.push(['SET', 'pstats_backfill_done', String(Date.now())]);
  await pipeline(cmds);

  return res.status(200).json({ ok: true, scanned, backfilled, skippedNew });
}
