// One "next best action" engine for owner listings — the single source of
// truth every owner touchpoint consumes (Airbnb-style opportunities engine,
// see docs/design-refs/airbnb-host-listing-flow.md):
//
//   - api/portal.js ownerReport   → payload.nextActions (weekly report,
//     public tokenized report page, portal Reports tab, and Maya server-side
//     when she answers owner questions — she fetches the same report)
//   - api/portal.js listProperties → per-listing `checklist` (My properties
//     card "next step" line, post-publish improvement queue)
//
// Two tiers, ranked performance-first:
//   nextActions()   — full engine; needs the report's stats bundle.
//   fieldChecklist() — record-only gaps; cheap (no Drive/stats), safe to run
//                      on every properties fetch.
//
// Hostex catalog units are Samba-curated: field gaps don't apply, only
// performance actions do.

function fmtRange(a, b) {
  const da = new Date(a + 'T00:00:00'), db = new Date(b + 'T00:00:00');
  const same = da.getMonth() === db.getMonth() && da.getFullYear() === db.getFullYear();
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  return da.toLocaleDateString('en-GB', same ? { day: 'numeric', timeZone: 'UTC' } : opts)
    + ' – ' + db.toLocaleDateString('en-GB', opts);
}

const has = v => !!(v && String(v).trim());
const arr = v => (Array.isArray(v) ? v.filter(Boolean) : []);

// Record-only listing gaps, most valuable first. Every item: {key,title,detail}.
export function fieldChecklist(rec) {
  if (!rec || rec.hostex) return [];
  const out = [];
  if (!has(rec.icalUrl)) out.push({
    key: 'ical',
    title: 'Connect your booking calendar',
    detail: "An iCal link keeps availability accurate and puts this villa in Maya's daily broadcast to agents.",
  });
  if (!has(rec.folder) && !has(rec.photosLink)) out.push({
    key: 'photos',
    title: 'Add photos',
    detail: '5 photos is enough to go live — great photos are what get a villa shared.',
  });
  if (String(rec.overview || '').trim().length < 100) out.push({
    key: 'overview',
    title: 'Write a longer overview',
    detail: 'Agents read this out to their clients — a few sentences on what makes it special goes a long way.',
  });
  if (arr(rec.features).length < 4) out.push({
    key: 'features',
    title: 'Pick at least 4 key features',
    detail: 'Features are how agents match your villa to what a client asked for.',
  });
  if (!has(rec.monthly)) out.push({
    key: 'price',
    title: 'Set a monthly price',
    detail: 'Listings without a price get skipped — agents can’t pitch what they can’t quote.',
  });
  if (!has(rec.location) && !has(rec.mapLink)) out.push({
    key: 'location',
    title: 'Pin the location on the map',
    detail: 'Area is the first filter agents apply.',
  });
  if (!has(rec.waNumber)) out.push({
    key: 'whatsapp',
    title: 'Add a WhatsApp contact',
    detail: 'This is the number agents tap when they have a client ready.',
  });
  return out;
}

// Full ranked engine for the weekly report. `stats` is the bundle ownerReport
// already computes; every field is optional — missing data just skips rules.
export function nextActions(rec, stats = {}) {
  const { metrics, funnel, occupancy, benchmark, agentsReached } = stats;
  const out = [];
  if (occupancy && Array.isArray(occupancy.openWindows) && occupancy.openWindows.length) {
    const w = occupancy.openWindows[0];
    out.push({
      key: 'fill-gap',
      title: `Fill your ${fmtRange(w.from, w.to)} gap`,
      detail: `A ${w.nights}-night opening between bookings. Maya can push a weekly-rate offer to the ${agentsReached || 0} agents already following this villa.`,
    });
  }
  if (funnel && funnel.viewed > 20 && (funnel.enquired / funnel.viewed) < 0.02) {
    out.push({
      key: 'refresh-photos',
      title: 'Refresh your photos',
      detail: 'Views are healthy but few turn into enquiries. New hero and interior shots typically lift the enquiry rate.',
    });
  }
  if (benchmark && benchmark.percentile != null && benchmark.percentile >= 70) {
    out.push({
      key: 'hold-rate',
      title: 'Hold your rate',
      detail: 'Demand is running well above comparable villas — no need to discount this month.',
    });
  }
  if (metrics && metrics.enquiries && metrics.views
      && metrics.enquiries.now === 0 && metrics.views.now > 5) {
    out.push({
      key: 'easy-enquiry',
      title: 'Make enquiring easy',
      detail: 'People are looking but not messaging. Check your WhatsApp contact and pricing are clear and up front.',
    });
  }
  out.push(...fieldChecklist(rec));
  if (!out.length) out.push({
    key: 'keep-current',
    title: 'Keep your calendar current',
    detail: "An up-to-date availability calendar keeps you in Maya's daily availability broadcast to agents.",
  });
  return out.slice(0, 5);
}
