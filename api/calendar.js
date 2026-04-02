export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.HOSTEX_TOKEN;
  if (!token) return res.status(500).json({ error: 'HOSTEX_TOKEN not configured' });

  const { id, start_date, end_date } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing property id' });

  try {
    const url = `https://api.hostex.io/v3/availabilities?property_ids%5B%5D=${id}&start_date=${start_date}&end_date=${end_date}`;
    const upstream = await fetch(url, {
      headers: { 'Hostex-Access-Token': token }
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
