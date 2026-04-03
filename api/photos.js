export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.HOSTEX_TOKEN;
  if (!token) return res.status(500).json({ error: 'HOSTEX_TOKEN not configured' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing property id' });

  try {
    const upstream = await fetch(`https://api.hostex.io/v3/properties/${id}`, {
      headers: { 'Hostex-Access-Token': token }
    });
    const data = await upstream.json();
    const property = data.data?.property || data.data || {};
    const photos = property.photos || property.images || [];
    // Always include cover as first photo
    const cover = property.cover?.original_url || property.cover?.large_url || null;
    const allPhotos = cover
      ? [cover, ...photos.map(p => p.original_url || p.large_url || p.url).filter(Boolean)]
      : photos.map(p => p.original_url || p.large_url || p.url).filter(Boolean);
    return res.status(200).json({ photos: [...new Set(allPhotos)] });
  } catch (e) {
    return res.status(502).json({ error: 'Upstream error', detail: e.message });
  }
}
