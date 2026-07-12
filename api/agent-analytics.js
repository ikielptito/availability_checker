// Per-agent portal engagement, for the CRM to join onto its message read-rate
// data (the sent→read→clicked→enquired funnel). Auth'd with the same shared
// secret the CRM uses for listing sync. Returns, per CRM agent id that has ever
// clicked a tracked link: clicks (listing engagement), enquiries (WhatsApp
// clicks), and last-seen timestamp.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const secret = process.env.LISTING_SYNC_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    // Every CRM agent id that has ever engaged.
    const membersRes = await fetch(`${url}/smembers/unique:agents:all`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const members = (await membersRes.json())?.result || [];
    const aids = members.filter(a => /^\d{1,12}$/.test(String(a)));
    if (!aids.length) return res.status(200).json({ agents: {}, count: 0 });

    // Pipeline HGETALL events + GET last_seen for each agent.
    const cmds = [];
    aids.forEach(aid => { cmds.push(['HGETALL', `agent:${aid}:events`], ['GET', `agent:${aid}:last_seen`]); });
    const results = await kv(cmds);

    // HGETALL returns a flat [k,v,k,v]; normalize to an object.
    const toObj = (arr) => {
      const o = {};
      if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
      return o;
    };

    const agents = {};
    aids.forEach((aid, i) => {
      const ev = toObj(results[i * 2]?.result);
      const lastSeen = results[i * 2 + 1]?.result;
      const clicks = (ev.listing_view || 0) + (ev.details_open || 0) + (ev.photo_view || 0);
      const enquiries = ev.whatsapp_click || 0;
      if (clicks || enquiries || lastSeen) {
        agents[aid] = {
          clicks,
          enquiries,
          page_views: ev.page_view || 0,
          last_seen: lastSeen ? Number(lastSeen) : null,
        };
      }
    });

    // Channel attribution totals (broadcast-driven vs organic).
    const today = new Date().toISOString().split('T')[0];
    let channels = {};
    try {
      const chRes = await kv([
        ['GET', 'total:src:wa_alert'], ['GET', 'total:src:wa_digest'],
        ['GET', `day:${today}:src:wa_alert`], ['GET', `day:${today}:src:wa_digest`],
      ]);
      channels = {
        wa_alert_all: Number(chRes[0]?.result) || 0,
        wa_digest_all: Number(chRes[1]?.result) || 0,
        wa_alert_today: Number(chRes[2]?.result) || 0,
        wa_digest_today: Number(chRes[3]?.result) || 0,
      };
    } catch { /* channels best-effort */ }

    return res.status(200).json({ agents, count: Object.keys(agents).length, channels });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
