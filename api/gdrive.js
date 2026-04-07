export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GOOGLE_API_KEY not configured' });

  const { folder } = req.query;
  if (!folder) return res.status(400).json({ error: 'Missing folder id' });

  try {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folder}'+in+parents+and+mimeType+contains+'image/'&fields=files(id,name,mimeType)&key=${apiKey}&pageSize=50`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const photos = (data.files || []).map(f => ({
      id: f.id,
      url: `https://lh3.googleusercontent.com/d/${f.id}`,
      thumb: `https://lh3.googleusercontent.com/d/${f.id}=w400`
    }));
    return res.status(200).json({ photos });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
