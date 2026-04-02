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
    // Fetch all reservations for this property (paginate if needed)
    const url = `https://api.hostex.io/v3/reservations?property_id=${id}&per_page=100&page=1`;
    const upstream = await fetch(url, {
      headers: { 'Hostex-Access-Token': token }
    });
    const data = await upstream.json();
    const reservations = data.data?.reservations || [];

    // Expand each reservation into individual booked dates
    const bookedDates = [];
    reservations.forEach(r => {
      if (r.status === 'cancelled') return;
      const cur = new Date(r.check_in_date);
      const end = new Date(r.check_out_date);
      while (cur < end) {
        bookedDates.push({
          date: cur.toISOString().split('T')[0],
          status: 'booked'
        });
        cur.setDate(cur.getDate() + 1);
      }
    });

    return res.status(200).json({ data: { items: bookedDates } });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
