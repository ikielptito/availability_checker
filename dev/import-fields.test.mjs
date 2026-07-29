#!/usr/bin/env node
// Unit tests for the listing importer's pure extraction (extractListingFields
// in api/portal.js), focused on the photo pipeline. Validated against real
// Airbnb pages on 29 Jul 2026; this synthetic fixture pins the behaviours:
//   - only the listing's own photos (numeric + base64 id forms), junk excluded
//   - dedupe across the two id encodings (same uuid filename)
//   - og:image promoted to the front
//   - Booking bstatic URLs normalized to the max1024x768 variant
// Run: node dev/import-fields.test.mjs

process.env.KV_REST_API_URL ||= 'http://kv';
process.env.KV_REST_API_TOKEN ||= 't';
const { extractListingFields } = await import(new URL('../api/portal.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.error('FAIL', name); } };

const ID = '1352513008639422403';
const B64 = Buffer.from(`StaySupplyListing:${ID}`).toString('base64'); // U3RheVN1cHBseUxpc3Rpbmc6MTM1MjUxMzAwODYzOTQyMjQwMw==

const airbnbHtml = `
<title>Brand New 1BR Villa - Villas for Rent in Canggu</title>
<meta property="og:title" content="Brand New 1BR Villa - Villas for Rent" />
<meta property="og:description" content="Villa in Canggu · ★4.9 · 1 bedroom · 1 bed · 1 bath" />
<meta property="og:image" content="https://a0.muscache.com/im/pictures/miso/Hosting-${ID}/original/cover-uuid-2222.jpeg?im_w=1200" />
<script>var x = {"images":[
 "https://a0.muscache.com/im/pictures/hosting/Hosting-${ID}/original/aaaa-uuid-1111.jpeg",
 "https://a0.muscache.com/im/pictures/miso/Hosting-${ID}/original/cover-uuid-2222.jpeg",
 "https:\\u002F\\u002Fa0.muscache.com\\u002Fim\\u002Fpictures\\u002Fhosting\\u002FHosting-${encodeURIComponent(B64)}\\u002Foriginal\\u002Faaaa-uuid-1111.jpeg",
 "https://a0.muscache.com/im/pictures/hosting/Hosting-${ID}/original/cccc-uuid-3333.jpeg",
 "https://a0.muscache.com/im/pictures/hosting/Hosting-999999/original/other-listing.jpeg",
 "https://a0.muscache.com/im/pictures/AirbnbPlatformAssets/AirbnbPlatformAssets-Favicons/original/junk.png",
 "https://a0.muscache.com/im/pictures/user/avatar-uuid.jpeg"
]};</script>`;

const a = extractListingFields(airbnbHtml, 'www.airbnb.ca', `/rooms/${ID}`);
t('airbnb: 3 own photos (dedup across encodings)', (a.photos || []).length === 3);
t('airbnb: excludes other listings + platform assets + avatars',
  !(a.photos || []).some(p => /999999|PlatformAssets|\/user\//.test(p)));
t('airbnb: og:image cover promoted first', (a.photos || [])[0]?.includes('cover-uuid-2222'));
t('airbnb: bedrooms parsed alongside photos', a.bedrooms === 1);

const bookingHtml = `
<title>The Anvaya Beach Resort - Booking.com</title>
<meta property="og:description" content="Featuring a garden, the villa has 2 bedrooms and 2 bathrooms." />
<script type="application/ld+json">{"@type":"Hotel","name":"The Anvaya","description":"A long description of the resort with plenty of prose to prefer over the meta line.","address":{"addressLocality":"Kuta","addressRegion":"Bali"}}</script>
<img src="https://cf.bstatic.com/xdata/images/hotel/square60/12345.jpg?k=abc">
<img src="https://cf.bstatic.com/xdata/images/hotel/max500/67890.jpg?k=def">`;

const b = extractListingFields(bookingHtml, 'www.booking.com', '/hotel/id/x.html');
t('booking: photos extracted', (b.photos || []).length === 2);
t('booking: sizes normalized to max1024x768', (b.photos || []).every(p => p.includes('/max1024x768/')));
t('booking: name from JSON-LD', b.name === 'The Anvaya');

// No id in the path (short link) → falls back to all non-junk photos.
const c = extractListingFields(airbnbHtml, 'www.airbnb.com', '/l/shortlink');
t('airbnb short-link: falls back to non-junk set', (c.photos || []).length === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
