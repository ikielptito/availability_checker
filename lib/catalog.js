// Canonical Hostex unit catalog — the single source of truth for the identity
// and pricing fields that MUST stay in sync across the serverless functions
// (api/listings.js, api/digest.js, api/check-availability.js).
//
// Historically each of those files hard-coded its own copy of this list, which
// drifted over time. They now all import from here. Presentation that is
// *intentionally* per-consumer (e.g. the digest's WhatsApp-tuned area tags, or
// the portal's building descriptions) still lives in each file — only the
// shared identity/price/folder lives here.
//
// NOTE: the browser portal (public/index.html) can't import this (no build
// step); it fetches the same data at runtime from /api/listings and overlays
// its hard-coded PROPS fallback, so keep that fallback roughly in step too.
//
// `order` groups buildings together with units in sequence (HAUS block, then
// LaneHAUS, Villa Saturno, then Tropicana). Tropicana units all share one
// Drive folder (a single shared photo set).

const TROPICANA_FOLDER = '1voeHZet0DspSnBeLeAIWarz-FPqUCUAr';

export const UNITS = [
  { hostexId: '11621510', slug: 'haus-1',        order: 10, unitType: '1BR Apartment', name: 'HAUS Canggu – Unit 1',      monthly: '27jt', yearly: '270jt', yearly2: '',      folder: '1xkEkRprYDCIfSCwCmfuPgcszI5kakOKF' },
  { hostexId: '11621511', slug: 'haus-2',        order: 11, unitType: '1BR Apartment', name: 'HAUS Canggu – Unit 2',      monthly: '27jt', yearly: '270jt', yearly2: '',      folder: '11Pr1akQilpBkgT37BhbajsneP7Ekijmu' },
  { hostexId: '11621512', slug: 'haus-4',        order: 12, unitType: '1BR Apartment', name: 'HAUS Canggu – Unit 4',      monthly: '30jt', yearly: '300jt', yearly2: '',      folder: '1qpdTd5oDxIbGkISxgSTKNJ3BtYM_aDEw' },
  { hostexId: '11621513', slug: 'haus-5',        order: 13, unitType: '1BR Apartment', name: 'HAUS Canggu – Unit 5',      monthly: '30jt', yearly: '300jt', yearly2: '',      folder: '1mxfot6q9JVF2C22wPpVzyNP8zVotJURr' },
  { hostexId: '11621507', slug: 'lanehaus-1',    order: 20, unitType: '1BR Townhouse', name: 'LaneHAUS – Unit 1',         monthly: '24jt', yearly: '240jt', yearly2: '',      folder: '1f6mhoH36L-uY5ncGq5LHhq2_dMS_20cd' },
  { hostexId: '11621509', slug: 'lanehaus-3',    order: 21, unitType: '1BR Townhouse', name: 'LaneHAUS – Unit 3',         monthly: '22jt', yearly: '220jt', yearly2: '',      folder: '1OY71DdG07xakOCCMZJAz4CqiI4EQm24F' },
  { hostexId: '12552236', slug: 'villa-saturno', order: 30, unitType: '3BR Villa',     name: 'Villa Saturno',             monthly: '40jt', yearly: '350jt', yearly2: '600jt', folder: '19Fh1nnnN6pvR3Ia4Pd2opB-J1D0hj1fZ' },
  { hostexId: '12484483', slug: 'tropicana-a4',  order: 40, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit A4', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12450063', slug: 'tropicana-a5',  order: 41, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit A5', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12566585', slug: 'tropicana-b2',  order: 42, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit B2', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12566586', slug: 'tropicana-b3',  order: 43, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit B3', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12606732', slug: 'tropicana-b4',  order: 44, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit B4', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12566587', slug: 'tropicana-b5',  order: 45, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit B5', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
  { hostexId: '12566588', slug: 'tropicana-b6',  order: 46, unitType: '1BR Villa',     name: 'Tropicana Valley – Unit B6', monthly: '30jt', yearly: '300jt', yearly2: '',     folder: TROPICANA_FOLDER },
];

// Lookups the consumers build their per-file projections from.
export const UNITS_BY_SLUG = Object.fromEntries(UNITS.map(u => [u.slug, u]));
export const UNITS_BY_ID = Object.fromEntries(UNITS.map(u => [u.hostexId, u]));
