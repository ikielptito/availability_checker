// End-to-end logic test: emulates Upstash REST + runs real handlers
process.env.KV_REST_API_URL = 'http://kv';
process.env.KV_REST_API_TOKEN = 't';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.DIGEST_SHARED_SECRET = 'digest_secret';
process.env.HOSTEX_TOKEN = 'fake';
process.env.LISTING_SYNC_SECRET = 'sync_secret';

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
    case 'DEL': { const had = store.delete(a[0]); return had ? 1 : 0; }
    default: throw new Error('unhandled op ' + op);
  }
}

const api = (f) => new URL(`../api/${f}`, import.meta.url).href;
const listingsMod = await import(api('listings.js'));
const trackMod = await import(api('track.js'));
const dashMod = await import(api('dashboard.js'));
const digestMod = await import(api('digest.js'));
const icalMod = await import(api('ical.js'));
const portalMod = await import(api('portal.js'));
const calMod = await import(api('calendar.js'));

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
  // Owner-report occupancy self-fetch → run the real calendar handler
  // (which in turn hits the Hostex mocks below).
  if (u.includes('/api/calendar')) {
    const q = Object.fromEntries(new URL(u).searchParams);
    const res = await call(calMod, { method: 'GET', query: q });
    return { ok: res.code === 200, json: async () => res.data };
  }
  // Upstash SCAN (owner:* enumeration in the owner_sync feed).
  if (u.startsWith('http://kv/scan/')) {
    const match = decodeURIComponent((u.match(/match=([^&]+)/) || [])[1] || '*');
    const prefix = match.replace(/\*$/, '');
    const keys = [...store.keys()].filter(k => k.startsWith(prefix));
    return { json: async () => ({ result: ['0', keys] }) };
  }
  if (u === 'http://ics/villa-merman.ics') {
    return { ok: true, status: 200, text: async () => MOCK_ICS };
  }
  // Hostex API mocks for the digest endpoint
  if (u.includes('api.hostex.io/v3/reservations')) {
    const id = (u.match(/property_id=(\d+)/) || [])[1];
    const cal = hostexCalendars[id] || {};
    return { ok: true, status: 200, json: async () => ({ data: { reservations: cal.reservations || [] } }) };
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

// ── Owner portal: Hostex catalog units as owned listings ─────────────
// Covers: assign-owner on a Hostex slug, email claim on sign-in, numeric
// propId analytics, service report + Hostex occupancy, owner write guards,
// the admin-edit ownership-wipe regression, public field stripping, and the
// (listing, contact)-pair owner_sync feed.
const TD = new Date().toISOString().split('T')[0];
store.set('session:tok1', JSON.stringify({ sub: 'sub-ikiel', exp: Date.now() + 86400000 }));
store.set('owner:sub-ikiel', JSON.stringify({ sub: 'sub-ikiel', email: 'ikielptito@gmail.com', name: 'Ikiel' }));
const ownerHeaders = { cookie: 'samba_session=tok1', host: 'kv-test' };

r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { action: 'assign-owner', slug: 'haus-1', ownerEmail: 'IkielPtito@Gmail.com' } });
check('assign-owner accepts Hostex slug', r.code === 200 && r.data.hostex === true && r.data.ownerEmail === 'ikielptito@gmail.com', JSON.stringify(r.data));

r = await call(portalMod, { method: 'GET', query: { action: 'properties' }, headers: ownerHeaders });
const hoProps = r.data?.properties || [];
const haus = hoProps.find(p => p.slug === 'haus-1');
check('portal lists claimed Hostex unit', !!haus && haus.hostex === true && haus.status === 'live' && haus.subscription === null, JSON.stringify(hoProps.map(p => p.slug)));
// Next-actions engine: custom listings carry a record-only checklist; Samba-
// curated Hostex units never do (fields are managed by us).
check('custom listings carry checklist, Hostex units do not',
  hoProps.every(p => p.hostex ? !(p.checklist || []).length : Array.isArray(p.checklist)),
  JSON.stringify(hoProps.map(p => [p.slug, p.hostex, (p.checklist || []).length])));
const hausOv = JSON.parse(store.get('listing:haus-1'));
check('claim stamped ownerSub into override', hausOv.ownerSub === 'sub-ikiel', store.get('listing:haus-1'));
check('owner_listings index contains haus-1', (JSON.parse(store.get('owner_listings:sub-ikiel')) || []).includes('haus-1'));

exec(['HINCRBY', `pstats:${TD}`, '11621510:details_open', '7']);
r = await call(portalMod, { method: 'GET', query: { action: 'analytics', period: '7d' }, headers: ownerHeaders });
const hausA = (r.data?.properties || []).find(p => p.slug === 'haus-1');
check('analytics counts numeric-propId events', hausA && hausA.details_open === 7, JSON.stringify(r.data?.properties));

// One accepted reservation with the real v3 financial shape (booked yesterday,
// 3 nights ahead) + 2 closed dates → occupancy 5 nights, bookings week/net set.
hostexCalendars['11621510'] = { reservations: [
  { status: 'accepted', channel_type: 'airbnb', check_in_date: isoNext(TD, 5), check_out_date: isoNext(TD, 8),
    booked_at: `${isoNext(TD, -1)}T09:00:00+00:00`,
    rates: { total_rate: { currency: 'IDR', amount: 3000000 }, total_commission: { currency: 'IDR', amount: 400000 } },
    payment: { currency: 'IDR', total_amount: 2600000 } },
], closedDates: [isoNext(TD, 1), isoNext(TD, 2)] };
r = await call(portalMod, { method: 'GET', query: { action: 'report', slug: 'haus-1' },
  headers: { authorization: 'Bearer sync_secret', host: 'kv-test' } });
check('service report for Hostex slug returns metrics', r.code === 200 && r.data?.metrics && /HAUS/.test(r.data.name), r.code);
check('report carries ranked nextActions', Array.isArray(r.data?.nextActions) && r.data.nextActions.length > 0 && r.data.nextActions.every(a => a.key && a.title && a.detail), JSON.stringify(r.data?.nextActions));
check('report occupancy from Hostex calendar', r.data?.occupancy && r.data.occupancy.bookedNights === 5, JSON.stringify(r.data?.occupancy));
const bk = r.data?.bookings;
check('report bookings from Hostex reservations',
  bk && bk.week.count === 1 && bk.week.nights === 3 && bk.week.net === 2600000 && bk.week.gross === 3000000
  && bk.week.byChannel.Airbnb === 1 && bk.upcoming.count === 1 && bk.upcoming.adr === Math.round(2600000 / 3),
  JSON.stringify(bk));

r = await call(portalMod, { method: 'POST', query: { action: 'property' }, headers: ownerHeaders,
  body: { slug: 'haus-1', data: { name: 'HACKED NAME', monthly: '1jt', waContactName: 'Manager Made', waNumber: '628111', reportContactName: 'Ikiel', reportWaNumber: '628222' } } });
check('hostex owner edit ok (contact-only)', r.code === 200 && r.data.hostex === true, JSON.stringify(r.data));
let ov2 = JSON.parse(store.get('listing:haus-1'));
check('hostex owner edit cannot change name/price', ov2.name === undefined && ov2.monthly === undefined, JSON.stringify(ov2));
check('hostex owner edit stored contacts', ov2.waNumber === '628111' && ov2.reportWaNumber === '628222' && ov2.reportContactName === 'Ikiel', JSON.stringify(ov2));

r = await call(portalMod, { method: 'DELETE', query: { action: 'property', slug: 'haus-1' }, headers: ownerHeaders });
check('hostex delete blocked 403', r.code === 403, r.code);

// Admin content edit must NOT wipe ownership or report contacts (regression:
// the Hostex write path rebuilds the whole override).
r = await call(listingsMod, { method: 'POST', headers: { authorization: 'Bearer pw' },
  body: { slug: 'haus-1', data: { monthly: '28jt', reportWaNumber: '628333' } } });
const ov3 = JSON.parse(store.get('listing:haus-1'));
check('admin edit preserves ownerSub/ownerEmail', ov3.ownerSub === 'sub-ikiel' && ov3.ownerEmail === 'ikielptito@gmail.com', JSON.stringify(ov3));
check('admin edit updates report contact + keeps ops contact', ov3.reportWaNumber === '628333' && ov3.waNumber === '628111', JSON.stringify(ov3));

r = await call(listingsMod, { method: 'GET' });
const leakFields = ['ownerEmail', 'ownerSub', 'ownerWa', 'reportWaNumber', 'reportContactName'];
const leaked = r.data.listings.filter(l => leakFields.some(f => f in l));
check('public listings strip owner fields', leaked.length === 0, JSON.stringify(leaked.map(l => l.slug)));
const h1pub = r.data.listings.find(l => l.slug === 'haus-1');
check('public listing keeps ops waNumber', h1pub && h1pub.waNumber === '628111', JSON.stringify(h1pub?.waNumber));
r = await call(listingsMod, { method: 'GET', query: { all: '1' }, headers: { authorization: 'Bearer pw' } });
check('admin ?all=1 still sees ownerEmail', r.data.listings.find(l => l.slug === 'haus-1')?.ownerEmail === 'ikielptito@gmail.com');

r = await call(dashMod, { method: 'GET', query: { owner_sync: '1' }, headers: { authorization: 'Bearer sync_secret' } });
const feedRows = r.data?.owners || [];
const h1rows = feedRows.filter(x => x.slug === 'haus-1');
check('feed emits Hostex ops + report rows',
  h1rows.length === 2
  && h1rows.some(x => x.role === 'ops' && x.waNumber === '628111')
  && h1rows.some(x => x.role === 'report' && x.waNumber === '628333'),
  JSON.stringify(h1rows));
check('feed Hostex rows live:true with owner identity', h1rows.every(x => x.live === true && x.ownerEmail === 'ikielptito@gmail.com'), JSON.stringify(h1rows));

// ── Maya intake (action=intake) ─────────────────────────────────────
// Regression cover for 16 Aug 2026: a burst of concurrent intakes for ONE
// villa created casa-suhana … casa-suhana-15 because every submission arrived
// without a slug and the old code appended -N whenever the slug was taken.
const intake = (body) => call(portalMod, {
  method: 'POST', query: { action: 'intake' },
  headers: { authorization: 'Bearer sync_secret' }, body,
});
const customCount = (pred) => Object.values(JSON.parse(store.get('custom_properties') || '{}')).filter(pred).length;

r = await intake({ waNumber: '447378973820', data: { name: 'Casa Suhana', area: 'Cemagi', bedrooms: 3, monthly: 'IDR 40.000.000/month' } });
check('intake creates the listing', r.code === 200 && r.data.slug === 'casa-suhana', JSON.stringify(r.data));

// Same owner, same villa, no slug → must UPDATE, not spawn casa-suhana-2.
r = await intake({ waNumber: '447378973820', data: { name: 'Casa Suhana', area: 'Cemagi', bedrooms: 3, bathrooms: 3, monthly: 'IDR 40.000.000/month' } });
check('intake without a slug updates the owner\'s existing villa', r.code === 200 && r.data.slug === 'casa-suhana', JSON.stringify(r.data));
check('intake did not create a duplicate', customCount(v => v.name === 'Casa Suhana') === 1, String(customCount(v => v.name === 'Casa Suhana')));

// Concurrent submissions (the actual failure mode) must converge on one slug
// and must not drop each other from the shared custom_properties blob.
const before = Object.keys(JSON.parse(store.get('custom_properties') || '{}')).length;
const burst = await Promise.all([1, 2, 3, 4, 5].map(i =>
  intake({ waNumber: '447378973820', data: { name: 'Casa Suhana', area: 'Cemagi', bedrooms: 3, bathrooms: 3, monthly: 'IDR 40.000.000/month', overview: `take ${i}` } })));
check('concurrent intakes all resolve to one slug', burst.every(x => x.code === 200 && x.data.slug === 'casa-suhana'), JSON.stringify(burst.map(x => x.data?.slug)));
check('concurrent intakes create no duplicates', customCount(v => v.name === 'Casa Suhana') === 1, String(customCount(v => v.name === 'Casa Suhana')));
check('concurrent intakes drop no other listings', Object.keys(JSON.parse(store.get('custom_properties'))).length === before, String(Object.keys(JSON.parse(store.get('custom_properties'))).length) + ' vs ' + before);

// A different owner submitting the same villa name still gets their own slug.
r = await intake({ waNumber: '628999000111', data: { name: 'Casa Suhana', area: 'Ubud' } });
check('a different owner gets a separate slug', r.code === 200 && r.data.slug === 'casa-suhana-2', JSON.stringify(r.data));

// Ownership gate still holds when a slug IS supplied.
r = await intake({ slug: 'casa-suhana', waNumber: '628999000111', data: { name: 'Casa Suhana' } });
check('intake with a slug rejects a foreign owner', r.code === 403, JSON.stringify(r.data));

console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
process.exit(failures ? 1 : 0);
