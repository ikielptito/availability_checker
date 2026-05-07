const HAUS = {
  tag: 'Batu Bolong · Canggu',
  location: 'https://maps.app.goo.gl/tMuPXqKHxhbKLDVe6',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1429!3d-8.6419!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzgnMzEuMCJTIDExNcKwMDgnMzQuNiJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Boutique collection of 8 fully furnished one-bedroom apartments in the heart of Batu Bolong. Steps from cafés, restaurants, and nightlife, yet tucked in a quiet residential lane.',
  features: ['43–46m² building · 4 are land', '1 Bedroom · 1 Bathroom', 'Large shared swimming pool', 'Outdoor lounge seating', 'Terrazzo bathrooms · Teak & rattan cabinetry', 'Fully equipped kitchen · Air-conditioning', 'High-speed fiber internet · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Electricity', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly'],
  locationHighlights: ['2-min walk to Bali Social Club', '5-min walk to Batu Bolong strip', '10-min ride to Batu Bolong Beach', '5-min drive to Pererenan'],
};
const LANE = {
  tag: 'Pererenan',
  location: 'https://maps.app.goo.gl/JGcqfdZMqUXSVjpD9',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1348!3d-8.6283!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzcnNDIuMCJTIDExNcKwMDgnMDMuMyJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Boutique collection of 3 fully furnished one-bedroom townhouses in central Pererenan. Walkable yet private, ideal for long-term living.',
  features: ['250m² land', '1 Bedroom · 1 Bathroom', 'Large shared swimming pool', 'XL king beds · Dedicated workspaces', 'Terrazzo floors & bathrooms', 'Fully equipped kitchen · Air-conditioning', '200mbps fiber (dedicated per unit) · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly', 'Electricity excluded for yearly'],
  locationHighlights: ['1-min to Pepito & Frestive', '3-min to Obsidian Gym', '4-min to Bar Vera', '8-min to Pererenan Beach', '10-min to La Brisa'],
};
const SATURNO = {
  tag: 'Padang Linjong · Canggu',
  location: 'https://maps.app.goo.gl/r4833cRt8oEXMjpD9',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1353!3d-8.6469!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzgnNDkuNiJTIDExNcKwMDgnMDcuMyJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Spacious 3-bedroom villa in prime Padang Linjong next to Bali Buddha. Central, walkable, and ideal for long-term living.',
  features: ['350m² land · 250m² building', '3 Bedrooms · 3 Bathrooms', 'Private swimming pool · Tropical garden', 'Enclosed AC living · Open-concept kitchen', 'Washing machine · Surfboards · Tennis rackets', 'Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly'],
  locationHighlights: ['Next to Bali Buddha', 'Walking distance to shops & cafés', 'Central Canggu location'],
};
const TROPICANA = {
  tag: 'Buduk · Near Canggu',
  location: 'https://maps.app.goo.gl/T78azqdxnspQAnVs5',
  mapEmbed: 'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3946.4!2d115.1549!3d-8.6153!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2zOMKwMzYnNTUuMSJTIDExNcKwMDknMTcuNiJF!5e0!3m2!1sen!2sid!4v1',
  overview: 'Modern private residences in Buduk offering private outdoor space, quiet surroundings, and proximity to Pererenan and Canggu.',
  features: ['60m² land · 75m² building', '1 Bedroom · 1 Bathroom', 'Private swimming pool & poolside seating', 'Balcony with bistro table · Dedicated workspace', 'Extra-large two-person wardrobe', 'Fully equipped kitchen · Air-conditioning', 'High-speed fiber internet · Fully furnished'],
  inclusions: ['400mbps fibre internet', 'Drinking water & cooking gas', 'Banjar fee & trash collection', 'Housekeeping 2× weekly', 'Linen & towels changed weekly', 'Electricity excluded for yearly'],
  locationHighlights: ['5-min to Pererenan', '10-min to Canggu', 'Quiet residential area'],
};

const DEFAULTS = {
  'haus-1':       { ...HAUS,      slug: 'haus-1',       hostexId: '11621510', name: 'HAUS Canggu – Unit 1',    monthly: '27jt', yearly: '270jt', yearly2: '', folder: '1xkEkRprYDCIfSCwCmfuPgcszI5kakOKF' },
  'haus-2':       { ...HAUS,      slug: 'haus-2',       hostexId: '11621511', name: 'HAUS Canggu – Unit 2',    monthly: '27jt', yearly: '270jt', yearly2: '', folder: '11Pr1akQilpBkgT37BhbajsneP7Ekijmu' },
  'haus-4':       { ...HAUS,      slug: 'haus-4',       hostexId: '11621512', name: 'HAUS Canggu – Unit 4',    monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1qpdTd5oDxIbGkISxgSTKNJ3BtYM_aDEw' },
  'haus-5':       { ...HAUS,      slug: 'haus-5',       hostexId: '11621513', name: 'HAUS Canggu – Unit 5',    monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1mxfot6q9JVF2C22wPpVzyNP8zVotJURr' },
  'lanehaus-1':   { ...LANE,      slug: 'lanehaus-1',   hostexId: '11621507', name: 'LaneHAUS – Unit 1',       monthly: '24jt', yearly: '240jt', yearly2: '', folder: '1f6mhoH36L-uY5ncGq5LHhq2_dMS_20cd' },
  'lanehaus-3':   { ...LANE,      slug: 'lanehaus-3',   hostexId: '11621509', name: 'LaneHAUS – Unit 3',       monthly: '22jt', yearly: '220jt', yearly2: '', folder: '1OY71DdG07xakOCCMZJAz4CqiI4EQm24F' },
  'villa-saturno':{ ...SATURNO,   slug: 'villa-saturno',hostexId: '12552236', name: 'Villa Saturno',           monthly: '40jt', yearly: '350jt', yearly2: '600jt', folder: '19Fh1nnnN6pvR3Ia4Pd2opB-J1D0hj1fZ' },
  'tropicana-a4': { ...TROPICANA, slug: 'tropicana-a4', hostexId: '12484483', name: 'Tropicana Valley – Unit A4', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-a5': { ...TROPICANA, slug: 'tropicana-a5', hostexId: '12450063', name: 'Tropicana Valley – Unit A5', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-b2': { ...TROPICANA, slug: 'tropicana-b2', hostexId: '12566585', name: 'Tropicana Valley – Unit B2', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-b3': { ...TROPICANA, slug: 'tropicana-b3', hostexId: '12566586', name: 'Tropicana Valley – Unit B3', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-b4': { ...TROPICANA, slug: 'tropicana-b4', hostexId: '12606732', name: 'Tropicana Valley – Unit B4', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-b5': { ...TROPICANA, slug: 'tropicana-b5', hostexId: '12566587', name: 'Tropicana Valley – Unit B5', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
  'tropicana-b6': { ...TROPICANA, slug: 'tropicana-b6', hostexId: '12566588', name: 'Tropicana Valley – Unit B6', monthly: '30jt', yearly: '300jt', yearly2: '', folder: '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr' },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Redis not configured' });

  async function kvGet(key) {
    const r = await fetch(`${kvUrl}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const json = await r.json();
    if (!json.result) return null;
    try { return JSON.parse(json.result); } catch { return null; }
  }

  async function kvSet(key, value) {
    await fetch(`${kvUrl}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value)
    });
  }

  if (req.method === 'GET') {
    const slugs = Object.keys(DEFAULTS);
    const kvResults = await Promise.all(slugs.map(s => kvGet(`listing:${s}`)));
    const listings = slugs.map((slug, i) => ({
      ...DEFAULTS[slug],
      ...(kvResults[i] || {}),
    }));
    return res.status(200).json({ listings });
  }

  if (req.method === 'POST') {
    const adminPw = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD;
    if (adminPw) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${adminPw}`) return res.status(401).json({ error: 'Unauthorized' });
    }

    const { slug, data } = req.body || {};
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'Invalid slug' });
    if (!DEFAULTS[slug]) return res.status(400).json({ error: 'Unknown listing slug' });

    const existing = await kvGet(`listing:${slug}`) || {};
    const safe = {
      slug,
      hostexId: existing.hostexId || DEFAULTS[slug].hostexId,
      name: typeof data.name === 'string' ? data.name.trim() : DEFAULTS[slug].name,
      folder: typeof data.folder === 'string' ? data.folder.trim() : existing.folder || DEFAULTS[slug].folder,
      overview: typeof data.overview === 'string' ? data.overview.trim() : existing.overview || DEFAULTS[slug].overview,
      features: Array.isArray(data.features) ? data.features.map(s => String(s).trim()).filter(Boolean) : existing.features || DEFAULTS[slug].features,
      inclusions: Array.isArray(data.inclusions) ? data.inclusions.map(s => String(s).trim()).filter(Boolean) : existing.inclusions || DEFAULTS[slug].inclusions,
      locationHighlights: Array.isArray(data.locationHighlights) ? data.locationHighlights.map(s => String(s).trim()).filter(Boolean) : existing.locationHighlights || DEFAULTS[slug].locationHighlights,
      monthly: typeof data.monthly === 'string' ? data.monthly.trim() : existing.monthly || DEFAULTS[slug].monthly,
      yearly: typeof data.yearly === 'string' ? data.yearly.trim() : existing.yearly || DEFAULTS[slug].yearly,
      yearly2: typeof data.yearly2 === 'string' ? data.yearly2.trim() : existing.yearly2 ?? DEFAULTS[slug].yearly2,
      tag: typeof data.tag === 'string' ? data.tag.trim() : existing.tag || DEFAULTS[slug].tag,
      location: typeof data.location === 'string' ? data.location.trim() : existing.location || DEFAULTS[slug].location,
      mapEmbed: typeof data.mapEmbed === 'string' ? data.mapEmbed.trim() : existing.mapEmbed || DEFAULTS[slug].mapEmbed,
    };

    await kvSet(`listing:${slug}`, safe);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
