import { runTranslate } from '../lib/translate.js';

export default async function handler(req, res) {
  // Bilingual translation shares this public endpoint to stay under the
  // serverless-function limit; /api/translate rewrites here (?action=translate).
  if (req.query && req.query.action === 'translate') return runTranslate(req, res);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return res.status(500).json({ error: 'Redis not configured' });

  const { event, propId, propName, agentId, newSession, src, stage, sharedBy } = req.body || {};
  if (!event || !/^[a-z_]{1,32}$/.test(event)) return res.status(400).json({ error: 'Missing or invalid event' });

  // Rate limit: this endpoint is public and writes analytics counters, so cap
  // it per-IP per-minute to stop a loop from inflating the view/share numbers we
  // show owners. Over the cap we silently accept (200) but don't record — clients
  // never see an error, so a real burst just drops the overflow.
  const RATE_LIMIT_PER_MIN = 150;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const minute = Math.floor(Date.now() / 60000);
  try {
    const rlKey = `rl:track:${ip}:${minute}`;
    const rlRes = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['INCR', rlKey], ['EXPIRE', rlKey, '120']]),
    });
    const rl = await rlRes.json().catch(() => null);
    const count = Array.isArray(rl) ? parseInt(rl[0]?.result) || 0 : 0;
    if (count > RATE_LIMIT_PER_MIN) return res.status(200).json({ ok: true, throttled: true });
  } catch { /* if the limiter itself fails, fall through and record normally */ }

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

  // Funnel stages: the frontend flags the FIRST engagement / enquiry of a
  // session, so these counters are unique sessions per stage — comparable to
  // `sessions` above, unlike raw event counters which can exceed it.
  if (stage === 'engaged' || stage === 'enquired') {
    const k = stage === 'engaged' ? 'eng_sessions' : 'wa_sessions';
    cmds.push(
      ['INCR', `total:${k}`],
      ['INCR', `day:${day}:${k}`],
      ['INCR', `month:${month}:${k}`]
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
    // Durable per-agent counters so the CRM can build a real per-agent funnel
    // (read-rate lives in the CRM; clicks/enquiries live here). Guard the id to
    // digits so it can't inject odd KV keys.
    const aid = /^\d{1,12}$/.test(String(agentId)) ? String(agentId) : null;
    if (aid) {
      cmds.push(['HINCRBY', `agent:${aid}:events`, event, '1']);
      cmds.push(['SET', `agent:${aid}:last_seen`, String(now)]);
      if (propId) cmds.push(['HINCRBY', `agent:${aid}:props`, `${propId}:${event}`, '1']);
      // Per-listing unique-agent reach: one daily set of agent ids per
      // property, so the owner report can SUNION the last 7 days for a real
      // "agents who saw or shared your villa this week" count (and the prior 7
      // for the week-over-week delta). Expire after 40 days — long enough to
      // cover a fortnight window with slack, short enough not to accumulate.
      if (propId) cmds.push(
        ['SADD', `uprop:${propId}:agents:${day}`, aid],
        ['EXPIRE', `uprop:${propId}:agents:${day}`, '3456000']
      );
    }
  }

  // Channel attribution — quantify broadcast-driven vs organic traffic. `src`
  // comes from the CRM tracked links (?ref=wa_alert / wa_digest); organic
  // visitors have none. Previously src was only in the transient events buffer.
  if (src && /^[a-z0-9_]{1,24}$/i.test(String(src))) {
    const s = String(src).toLowerCase();
    cmds.push(['INCR', `day:${day}:src:${s}`], ['INCR', `total:src:${s}`], ['INCR', `month:${month}:src:${s}`]);
  }

  // Share attribution: listing pages opened from an agent's personalised
  // link (?a=handle) credit that agent's handle with the resulting views and
  // WhatsApp enquiries — this is what proves which agents produce leads.
  if (sharedBy && /^[a-z0-9_.-]{1,40}$/i.test(String(sharedBy))) {
    const sb = String(sharedBy).toLowerCase();
    if (event === 'listing_view') {
      cmds.push(['HINCRBY', 'attr:views', sb, '1'], ['HINCRBY', `attr:views:${month}`, sb, '1']);
    } else if (event === 'whatsapp_click') {
      cmds.push(['HINCRBY', 'attr:wa', sb, '1'], ['HINCRBY', `attr:wa:${month}`, sb, '1']);
      if (propId) cmds.push(['HINCRBY', 'attr:wa:prop', `${propId}:${sb}`, '1']);
    }
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
