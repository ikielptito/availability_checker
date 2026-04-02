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
    const [resRes, availRes] = await Promise.all([
      fetch(`https://api.hostex.io/v3/reservations?property_id=${id}&per_page=100&page=1`, {
        headers: { 'Hostex-Access-Token': token }
      }),
      fetch(`https://api.hostex.io/v3/availabilities?property_ids[]=${id}&start_date=${start_date}&end_date=${end_date}`, {
        headers: { 
          'Hostex-Access-Token': token,
          'Content-Type': 'application/json'
        }
      })
    ]);

    const resData = await resRes.json();
    const availData = await availRes.json();

    const bookedDates = [];

    // Reservations → booked dates
    const reservations = resData.data?.reservations || [];
    reservations.forEach(r => {
      if (r.status === 'cancelled') return;
      const cur = new Date(r.check_in_date);
      const end = new Date(r.check_out_date);
      while (cur < end) {
        bookedDates.push({ date: cur.toISOString().split('T')[0], status: 'booked' });
        cur.setDate(cur.getDate() + 1);
      }
    });

    // Availabilities → closed dates
    const avails = availData.data?.availabilities || availData.data?.items || availData.data || [];
    if (Array.isArray(avails)) {
      avails.forEach(a => {
        if (a.available === false || a.status === 'closed' || a.closed === true) {
          bookedDates.push({ date: a.date, status: 'booked' });
        }
      });
    }

    return res.status(200).json({ 
      data: { items: bookedDates },
      _debug_avail: availData 
    });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
