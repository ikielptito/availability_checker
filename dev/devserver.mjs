// Local dev server: serves public/ with vercel.json rewrites and runs real api/ handlers
// against mocked Upstash/Hostex/Drive upstreams. For verification only.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = '/Users/ikiel/availability_checker';
process.env.KV_REST_API_URL = 'http://kv';
process.env.KV_REST_API_TOKEN = 't';
process.env.DASHBOARD_PASSWORD = 'Bissli2024';
process.env.HOSTEX_TOKEN = 'fake';
process.env.GOOGLE_API_KEY = 'fake';
process.env.DIGEST_SHARED_SECRET = 'dev_secret';

// ── mock redis ──
const store = new Map(), sets = new Map(), hashes = new Map(), lists = new Map();
function exec(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    case 'SET': store.set(a[0], a[1]); return 'OK';
    case 'INCR': { const v = (parseInt(store.get(a[0])) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'HINCRBY': { if (!hashes.has(a[0])) hashes.set(a[0], new Map()); const h = hashes.get(a[0]); const v = (parseInt(h.get(a[1])) || 0) + parseInt(a[2]); h.set(a[1], String(v)); return v; }
    case 'HGETALL': { const h = hashes.get(a[0]); if (!h) return []; const o = []; for (const [k, v] of h) o.push(k, v); return o; }
    case 'SADD': { if (!sets.has(a[0])) sets.set(a[0], new Set()); sets.get(a[0]).add(a[1]); return 1; }
    case 'SCARD': return sets.has(a[0]) ? sets.get(a[0]).size : 0;
    case 'SUNION': { const u = new Set(); a.forEach(k => (sets.get(k) || new Set()).forEach(m => u.add(m))); return [...u]; }
    case 'LPUSH': { if (!lists.has(a[0])) lists.set(a[0], []); lists.get(a[0]).unshift(a[1]); return lists.get(a[0]).length; }
    case 'LTRIM': { const l = lists.get(a[0]) || []; lists.set(a[0], l.slice(parseInt(a[1]), parseInt(a[2]) + 1)); return 'OK'; }
    case 'LRANGE': { const l = lists.get(a[0]) || []; return l.slice(parseInt(a[1]), parseInt(a[2]) + 1); }
    default: throw new Error('unhandled op ' + op);
  }
}

const HOSTEX_PROPS = [
  { id: 11621510, name: 'HAUS Canggu – Unit 1', property_type: 'Apartment', cover: { large_url: 'https://picsum.photos/seed/h1/400/300' } },
  { id: 11621511, name: 'HAUS Canggu – Unit 2', property_type: 'Apartment', cover: { large_url: 'https://picsum.photos/seed/h2/400/300' } },
  { id: 12552236, name: 'Villa Saturno', property_type: 'Villa', cover: { large_url: 'https://picsum.photos/seed/vs/400/300' } },
];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('http://kv/pipeline')) {
    const results = JSON.parse(opts.body).map(c => ({ result: exec(c) }));
    return { json: async () => results };
  }
  if (u.startsWith('http://kv/get/')) {
    const key = decodeURIComponent(u.slice('http://kv/get/'.length));
    return { json: async () => ({ result: store.has(key) ? store.get(key) : null }) };
  }
  if (u.startsWith('http://kv/set/')) {
    const key = decodeURIComponent(u.slice('http://kv/set/'.length));
    store.set(key, opts.body);
    return { json: async () => ({ result: 'OK' }) };
  }
  if (u.includes('api.hostex.io/v3/properties')) {
    return { status: 200, json: async () => ({ data: { properties: HOSTEX_PROPS } }) };
  }
  if (u.includes('api.hostex.io/v3/reservations')) {
    return { json: async () => ({ data: { reservations: [{ status: 'accepted', check_in_date: addDays(3), check_out_date: addDays(9) }] } }) };
  }
  if (u.includes('api.hostex.io/v3/availabilities')) {
    return { json: async () => ({ data: { properties: [{ availabilities: [{ date: addDays(14), available: false }, { date: addDays(15), available: false }] }] } }) };
  }
  if (u.includes('googleapis.com/drive')) {
    return { json: async () => ({ files: [{ id: 'ph1' }, { id: 'ph2' }, { id: 'ph3' }] }) };
  }
  if (u.includes('mock-ics')) {
    const compact = s => s.replace(/-/g, '');
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${compact(addDays(20))}`,
      `DTEND;VALUE=DATE:${compact(addDays(28))}`,
      'SUMMARY:Reserved via iCal',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    return { ok: true, status: 200, text: async () => ics };
  }
  if (u.includes('/api/listings')) {
    const res = shimRes();
    await handlers.listings.default({ method: 'GET', headers: {}, query: {} }, res);
    return { ok: true, json: async () => res._data };
  }
  return realFetch(url, opts);
};

function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }

const handlers = {};
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
  handlers[f.replace('.js', '')] = await import(path.join(ROOT, 'api', f));
}

function shimRes(nodeRes) {
  return {
    _code: 200, _headers: {}, _data: null,
    setHeader(k, v) { this._headers[k] = v; },
    status(c) { this._code = c; return this; },
    json(d) {
      this._data = d;
      if (nodeRes) { nodeRes.writeHead(this._code, { 'Content-Type': 'application/json', ...this._headers }); nodeRes.end(JSON.stringify(d)); }
      return this;
    },
    end() { if (nodeRes) { nodeRes.writeHead(this._code, this._headers); nodeRes.end(); } return this; },
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname.startsWith('/api/')) {
      const name = u.pathname.slice(5).replace(/\/$/, '');
      const mod = handlers[name];
      if (!mod) { res.writeHead(404); return res.end('{"error":"no such api"}'); }
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch {}
      const fakeReq = { method: req.method, headers: req.headers, query: Object.fromEntries(u.searchParams), body: parsed };
      return void await mod.default(fakeReq, shimRes(res));
    }
    let file;
    if (u.pathname === '/admin') file = 'admin.html';
    else if (u.pathname.startsWith('/l/')) file = 'listing.html';
    else {
      const candidate = u.pathname.replace(/^\//, '');
      file = candidate && fs.existsSync(path.join(ROOT, 'public', candidate)) ? candidate : 'index.html';
    }
    const fp = path.join(ROOT, 'public', file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(fs.readFileSync(fp));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

// Seed: one custom property + a few events
await handlers.listings.default({
  method: 'POST', headers: { authorization: 'Bearer Bissli2024' }, query: {},
  body: { slug: 'villa-sunrise', custom: true, data: {
    name: 'Villa Sunrise', tag: 'Umalas · Canggu', location: 'https://maps.app.goo.gl/x',
    overview: 'A test custom property managed outside Hostex.',
    monthly: '35jt', yearly: '350jt', waNumber: '6281200001111', waContactName: 'Ketut',
    features: ['2 Bedrooms · 2 Bathrooms', 'Private pool'], inclusions: ['Wifi', 'Housekeeping'],
    locationHighlights: ['5-min to Umalas cafés'], folder: 'FOLDER123',
    bookedRanges: [{ from: addDays(5), to: addDays(12) }], hidden: false,
    unitType: '2BR Villa', icalUrl: 'http://mock-ics/villa.ics',
  } },
}, shimRes());
const seedEvents = [
  { event: 'page_view', agentId: 'a_seed1', newSession: true, src: 'portal' },
  { event: 'details_open', propId: '11621510', propName: 'HAUS Canggu – Unit 1', agentId: 'a_seed1' },
  { event: 'whatsapp_click', propId: 'c_villa-sunrise', propName: 'Villa Sunrise', agentId: 'a_seed1' },
  { event: 'listing_view', propId: 'c_villa-sunrise', propName: 'Villa Sunrise', agentId: 'a_seed2', newSession: true, src: 'listing' },
  { event: 'share', propId: '12552236', propName: 'Villa Saturno', agentId: 'a_seed2' },
  { event: 'photo_view', propId: '12552236', propName: 'Villa Saturno', agentId: 'a_seed2' },
];
for (const e of seedEvents) await handlers.track.default({ method: 'POST', headers: {}, query: {}, body: e }, shimRes());

server.listen(3456, () => console.log('dev server on http://localhost:3456'));
