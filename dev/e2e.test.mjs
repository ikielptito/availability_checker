// End-to-end logic test: emulates Upstash REST + runs real handlers
process.env.KV_REST_API_URL = 'http://kv';
process.env.KV_REST_API_TOKEN = 't';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.DIGEST_SHARED_SECRET = 'digest_secret';
process.env.HOSTEX_TOKEN = 'fake';

const store = new Map(); // strings
const sets = new Map();  // Set
const hashes = new Map(); // Map
const lists = new Map(); // Array

function exec(cmd) {
  const [op, ...a] = cmd;
  switch (op) {
    case 'GET': return store.has(a[0]) ? store.get(a[0]) : null;
    case 'SET': store.set(a[0], a[1]); return 'OK';
    case 'INCR': { const v = (parseInt(store.get(a[0])) || 0) + 1; store.set(a[0], String(v)); return v; }
    case 'HINCRBY': {
      if (!hashes.has(a[0])) hashes.set(a[0], new Map());
      const h = hashes.get(a[0]);
      const v = (parseInt(h.get(a[1])) || 0) + parseInt(a[2]);
      h.set(a[1], String(v)); return v;
    }
    case 'HGETALL': {
      const h = hashes.get(a[0]);
      if (!h) return [];
      const out = [];
      for (const [k, v] of h) out.push(k, v);
      return out;
    }
    case 'SADD': { if (!sets.has(a[0])) sets.set(a[0], new Set()); sets.get(a[0]).add(a[1]); return 1; }
    case 'SCARD': return sets.has(a[0]) ? sets.get(a[0]).size : 0;
    case 'SUNION': { const u = new Set(); a.forEach(k => (sets.get(k) || new Set()).forEach(m => u.add(m))); return [...u]; }
    case 'LPUSH': { if (!lists.has(a[0])) lists.set(a[0], []); lists.get(a[0]).unshift(a[1]); return lists.get(a[0]).length; }
    case 'LTRIM': { const l = lists.get(a[0]) || []; lists.set(a[0], l.slice(parseInt(a[1]), parseInt(a[2]) + 1)); return 'OK'; }
    case 'LRANGE': { const l = lists.get(a[0]) || []; return l.slice(parseInt(a[1]), parseInt(a[2]) + 1); }
    default: throw new Error('unhandled op ' + op);
  }
}

const listingsMod = await import('/Users/ikiel/availability_checker/api/listings.js');
const trackMod = await import('/Users/ikiel/availability_checker/api/track.js');
const dashMod = await import('/Users/ikiel/availability_checker/api/dashboard.js');
const digestMod = await import('/Users/ikiel/availability_checker/api/digest.js');
const icalMod = await import('/Users/ikiel/availability_checker/api/ical.js');

// ── Hostex mock controls for digest test ─────────────────────────────
// hostexCalendars[propertyId] = { reservations: [{check_in_date, check_out_date, status}], closedDates: [YYYY-MM-DD] }
const hostexCalendars = {};
function isoNext(base, n) {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function fakeRes() {
  return {
    code: 200, data: null,
    setHeader() {}, status(c) { this.code = c; return this; },
    json(d) { this.data = d; return this; }, end() { return this; },
  };
}

async function call(mod, req) {
  const res = fakeRes();
  req.headers = req.headers || {};
  req.query = req.query || {};
  await mod.default(req, res);
  return res;
}

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
  if (u.includes('/api/listings')) {
    const res = await call(listingsMod, { method: 'GET' });
    return { ok: true, json: async () => res.data };
  }
  if (u === 'http://ics/villa-merman.ics') {
    return { ok: true, status: 200, text: async () => MOCK_ICS };
  }
  // Hostex API mocks for the digest endpoint
  if (u.includes('api.hostex.io/v3/reservations')) {
    const id = (u.match(/property_id=(\d+)/) || [])[1];
    const cal = hostexCalendars[id] || {};
    return { json: async () => ({ data: { reservations: cal.reservations || [] } }) };
  }
  if (u.includes('api.hostex.io/v3/availabilities')) {
    const id = (u.match(/property_ids=(\d+)/) || [])[1];
    const cal = hostexCalendars[id] || {};
    const availabilities = (cal.closedDates || []).map(date => ({ date, available: false }));
    return { json: async () => ({ data: { properties: [{ availabilities }] } }) };
  }
  throw new Error('unexpected fetch: ' + u);
};

let failures = 0;
function check(label, cond, extra) {
  if (cond) console.log('PASS', label);
  else { failures++; console.log('FAIL', label, extra ?? ''); }
}

// 1. Create a custom property
let r = await call(listingsMod, {
  method: 'POST',
  headers: { authorization: 'Bearer pw' },
  body: { slug: 'villa-test', custom: true, data: {
    name: 'Villa Test', tag: 'Umalas', location: 'https://maps.app.goo.gl/x',
    monthly: '35jt', yearly: '350jt', waNumber: '+62 812-0000-1111', waContactName: 'Ketut',
    features: ['2 Bedrooms', ''], inclusions: ['Wifi'], locationHighlights: [],
    folder: 'FOLDER123',
    bookedRanges: [{ from: '2026-07-01', to: '2026-07-10' }, { from: 'bad', to: 'x' }],
    hidden: false,
  } },
});
check('create custom returns ok', r.code === 200 && r.data.ok, JSON.stringify(r.data));

// 1b. Reject slug collision with Hostex listing
r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer pw' }, body: { slug: 'haus-1', custom: true, data: { name: 'X' } } });
check('rejects conflicting slug', r.code === 400);

// 1c. Reject bad auth
r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: { slug: 'v2', custom: true, data: { name: 'X' } } });
check('rejects bad auth', r.code === 401);

// 2. GET returns defaults + custom
r = await call(listingsMod, { method: 'GET' });
const ls = r.data.listings;
check('GET has 15 listings', ls.length === 15, ls.length);
const cv = ls.find(l => l.slug === 'villa-test');
check('custom listing present + sanitized', cv && cv.custom === true && cv.waNumber === '628120000​1111'.replace(/​/g, '') && cv.features.length === 1 && cv.bookedRanges.length === 1, JSON.stringify(cv));

// 3. Track events
const day = new Date().toISOString().split('T')[0];
await call(trackMod, { method: 'POST', body: { event: 'page_view', agentId: 'a_one', newSession: true, src: 'portal' } });
await call(trackMod, { method: 'POST', body: { event: 'page_view', agentId: 'a_one', newSession: false, src: 'portal' } });
await call(trackMod, { method: 'POST', body: { event: 'details_open', propId: '11621510', propName: 'HAUS Canggu – Unit 1', agentId: 'a_one' } });
await call(trackMod, { method: 'POST', body: { event: 'whatsapp_click', propId: 'c_villa-test', propName: 'Villa Test', agentId: 'a_one' } });
await call(trackMod, { method: 'POST', body: { event: 'listing_view', propId: 'c_villa-test', propName: 'Villa Test', agentId: 'a_two', newSession: true, src: 'listing' } });
await call(trackMod, { method: 'POST', body: { event: 'bad event!', agentId: 'x' } }).then(res => check('rejects bad event name', res.code === 400));

check('sessions counted once per session', store.get('total:sessions') === '2', store.get('total:sessions'));
check('page_view total = 2', store.get('total:page_view') === '2');
check('pstats hash written', hashes.get(`pstats:${day}`)?.get('c_villa-test:whatsapp_click') === '1');

// 4. Dashboard, period=7d
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer pw', host: 'x.test' }, query: { period: '7d' } });
const d = r.data;
check('dashboard 200', r.code === 200);
check('totals.sessions=2', d.totals.sessions === 2, d.totals.sessions);
check('totals.whatsapp_click=1', d.totals.whatsapp_click === 1);
check('totals.listing_view=1', d.totals.listing_view === 1);
check('unique agents period=2', d.totals.unique_agents === 2, d.totals.unique_agents);
check('series length 7', d.series.length === 7);
const today = d.series[d.series.length - 1];
check('today sessions=2 agents=2', today.sessions === 2 && today.agents === 2, JSON.stringify(today));
check('properties includes 15 entries', d.properties.length === 15, d.properties.length);
const pv = d.properties.find(p => p.id === 'c_villa-test');
check('custom prop period stats', pv && pv.whatsapp_click === 1 && pv.listing_view === 1 && pv.engagement === 1, JSON.stringify(pv));
const ph = d.properties.find(p => p.id === '11621510');
check('hostex prop period stats', ph && ph.details_open === 1, JSON.stringify(ph));
check('recent events recorded', d.recent.length === 5 && d.recent[0].event === 'listing_view', d.recent.length);

// 5. Dashboard, period=all
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer pw', host: 'x.test' }, query: { period: 'all' } });
check('all-time totals match', r.data.totals.sessions === 2 && r.data.totals.details_open === 1);
const pva = r.data.properties.find(p => p.id === 'c_villa-test');
check('all-time custom prop lifetime counters', pva && pva.whatsapp_click === 1, JSON.stringify(pva));

// 6. Dashboard auth
r = await call(dashMod, { method: 'GET', headers: { authorization: 'Bearer nope', host: 'x.test' }, query: {} });
check('dashboard rejects bad password', r.code === 401);

// 7. Delete custom
r = await call(listingsMod, { method: 'DELETE', headers: { authorization: 'Bearer pw' }, query: { slug: 'villa-test' } });
check('delete ok', r.code === 200);
r = await call(listingsMod, { method: 'GET' });
check('custom gone after delete', r.data.listings.length === 14);

// ── 8. DIGEST ENDPOINT ─────────────────────────────────────────────
// Reset KV state to a known shape so the digest's assertions are stable.
store.clear(); hashes.clear(); lists.clear(); sets.clear();
const T0 = new Date().toISOString().split('T')[0];

// Seed two custom properties + Hostex mock data
await call(listingsMod, {
  method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { slug: 'fully-booked', custom: true, data: {
    name: 'Fully Booked Villa', tag: 'Pererenan', monthly: '40jt',
    bookedRanges: [{ from: T0, to: isoNext(T0, 200) }],
  } },
});
await call(listingsMod, {
  method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { slug: 'long-window-villa', custom: true, data: {
    name: 'Long Window Villa', tag: 'Umalas', monthly: '35jt',
    // Booked first 5 days, then 30+ free, then booked again
    bookedRanges: [
      { from: T0, to: isoNext(T0, 4) },
      { from: isoNext(T0, 50), to: isoNext(T0, 60) },
    ],
  } },
});
await call(listingsMod, {
  method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { slug: 'hidden-villa', custom: true, data: {
    name: 'Hidden Villa', tag: 'Hidden', hidden: true,
  } },
});

// Hostex: HAUS-1 fully booked next 60 days (reservation), then opens up
hostexCalendars['11621510'] = {
  reservations: [{ check_in_date: T0, check_out_date: isoNext(T0, 60), status: 'accepted' }],
  closedDates: [],
};
// Hostex: HAUS-2 closed only days 10-12 (short closure → still has long window)
hostexCalendars['11621511'] = {
  reservations: [],
  closedDates: [isoNext(T0, 10), isoNext(T0, 11), isoNext(T0, 12)],
};
// All other Hostex props default to fully open

// 8a. Auth
r = await call(digestMod, { method: 'GET', headers: { authorization: 'Bearer wrong' } });
check('digest rejects bad auth', r.code === 401);

r = await call(digestMod, { method: 'GET', headers: { authorization: 'Bearer digest_secret' } });
check('digest 200 with shared secret', r.code === 200, r.data?.error);

const dg = r.data;
check('digest has asOf + properties', !!dg.asOf && Array.isArray(dg.properties));
check('digest includes 14 hostex + 2 visible custom (16)', dg.properties.length === 16, dg.properties.length);
check('hidden custom excluded', !dg.properties.find(p => p.id === 'c_hidden-villa'));

// 8b. Fully-booked custom property
const fb = dg.properties.find(p => p.id === 'c_fully-booked');
check('fully-booked: availableToday=false', fb && fb.availability.availableToday === false);
check('fully-booked: nextAvailableFrom null beyond horizon', fb && fb.availability.nextAvailableFrom === null);
check('fully-booked: nextLongWindowFrom null', fb && fb.availability.nextLongWindowFrom === null);
check('fully-booked: longWindowDays = 0', fb && fb.availability.longWindowDays === 0);

// 8c. Long-window custom property — first 5 days booked, then 45 free, then 11 booked, then open
const lw = dg.properties.find(p => p.id === 'c_long-window-villa');
check('long-window: availableToday=false', lw && lw.availability.availableToday === false);
check('long-window: nextAvailableFrom = today+5', lw && lw.availability.nextAvailableFrom === isoNext(T0, 5), lw?.availability);
check('long-window: nextLongWindowFrom = today+5 (45-day run is >= 30)', lw && lw.availability.nextLongWindowFrom === isoNext(T0, 5), lw?.availability);
check('long-window: longWindowDays ≥ 30', lw && lw.availability.longWindowDays >= 30, lw?.availability.longWindowDays);

// 8d. Hostex HAUS-1: booked first 60 days, then open → long window starts at day 60
const haus1 = dg.properties.find(p => p.id === '11621510');
check('haus-1: availableToday=false (booked next 60 days)', haus1 && haus1.availability.availableToday === false);
check('haus-1: nextAvailableFrom = today+60', haus1 && haus1.availability.nextAvailableFrom === isoNext(T0, 60), haus1?.availability);
check('haus-1: nextLongWindowFrom = today+60', haus1 && haus1.availability.nextLongWindowFrom === isoNext(T0, 60));

// 8e. Hostex HAUS-2: 3-day closure ~day 10 — short, can't span 30-day window from today,
// but the first window of 30 free days starts at day 13.
const haus2 = dg.properties.find(p => p.id === '11621511');
check('haus-2: availableToday=true', haus2 && haus2.availability.availableToday === true);
check('haus-2: nextAvailableFrom = today', haus2 && haus2.availability.nextAvailableFrom === T0);
check('haus-2: nextLongWindowFrom = today+13 (run starts after closure)', haus2 && haus2.availability.nextLongWindowFrom === isoNext(T0, 13), haus2?.availability);

// 8f. Fully-open Hostex (e.g. HAUS-4) → all good from today
const open = dg.properties.find(p => p.id === '11621512');
check('fully-open hostex: availableToday=true', open && open.availability.availableToday === true);
check('fully-open hostex: nextLongWindowFrom = today', open && open.availability.nextLongWindowFrom === T0);

// 8g. Cache hit on second call
r = await call(digestMod, { method: 'GET', headers: { authorization: 'Bearer digest_secret' } });
check('digest cache hit returns same payload', r.data && r.data.asOf === dg.asOf, 'asOf drifted');

// 8h. Cron-secret auth works too
process.env.CRON_SECRET = 'cron_secret';
r = await call(digestMod, { method: 'GET', headers: { authorization: 'Bearer cron_secret' }, query: { force: '1' } });
check('digest accepts CRON_SECRET', r.code === 200);

// ── 9. ICAL SYNC ────────────────────────────────────────────────────
// MOCK_ICS: all-day booking T0+2..T0+5 (DTEND exclusive → booked +2,+3,+4),
// a datetime booking T0+10..T0+12 (booked +10,+11), and a cancelled event.
const compact = s => s.replace(/-/g, '');
globalThis.MOCK_ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${compact(isoNext(T0, 2))}`,
  `DTEND;VALUE=DATE:${compact(isoNext(T0, 5))}`,
  'SUMMARY:Reserved',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `DTSTART:${compact(isoNext(T0, 10))}T140000Z`,
  `DTEND:${compact(isoNext(T0, 12))}T110000Z`,
  'SUMMARY:Booking',
  'END:VEVENT',
  'BEGIN:VEVENT',
  `DTSTART;VALUE=DATE:${compact(isoNext(T0, 20))}`,
  `DTEND;VALUE=DATE:${compact(isoNext(T0, 25))}`,
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

// Custom property with iCal + one manual range
await call(listingsMod, {
  method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { slug: 'villa-merman', custom: true, data: {
    name: 'Villa Merman', tag: 'Pererenan', unitType: '2BR Villa', monthly: '30jt',
    icalUrl: 'http://ics/villa-merman.ics',
    bookedRanges: [{ from: isoNext(T0, 40), to: isoNext(T0, 42) }],
  } },
});

r = await call(icalMod, { method: 'GET', query: { slug: 'villa-merman' } });
check('ical endpoint 200', r.code === 200, JSON.stringify(r.data));
const booked9 = new Set(r.data.booked || []);
check('ical: all-day range booked (DTEND exclusive)', booked9.has(isoNext(T0, 2)) && booked9.has(isoNext(T0, 4)) && !booked9.has(isoNext(T0, 5)), [...booked9].join(','));
check('ical: datetime range booked, checkout day free', booked9.has(isoNext(T0, 10)) && booked9.has(isoNext(T0, 11)) && !booked9.has(isoNext(T0, 12)));
check('ical: cancelled event excluded', !booked9.has(isoNext(T0, 20)));

r = await call(icalMod, { method: 'GET', query: { slug: 'no-such-villa' } });
check('ical: unknown slug 404', r.code === 404);

r = await call(icalMod, { method: 'GET', query: { slug: 'fully-booked' } });
check('ical: property without icalUrl returns empty', r.code === 200 && r.data.booked.length === 0);

// Digest merges iCal + manual ranges for the custom property
r = await call(digestMod, { method: 'GET', headers: { authorization: 'Bearer digest_secret' }, query: { force: '1' } });
const merman = r.data.properties.find(p => p.id === 'c_villa-merman');
check('digest includes villa-merman with unitType', merman && merman.unitType === '2BR Villa', JSON.stringify(merman));
check('digest merman availableToday=true (T0 free)', merman && merman.availability.availableToday === true);
// Blocked: +2..+4 (ical), +10..+11 (ical), +40..+42 (manual). Runs: 0..1 (2d),
// 5..9 (5d), 12..39 (28d — just under 30), then 43+ → first ≥30-day window at +43
check('digest merman long window starts after manual range', merman && merman.availability.nextLongWindowFrom === isoNext(T0, 43), merman?.availability.nextLongWindowFrom);

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
