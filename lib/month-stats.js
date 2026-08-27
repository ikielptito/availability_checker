// ── HOSTEX MONTH AGGREGATES ──────────────────────────────────────────
// Occupancy / nights / channel mix for one calendar month, per unit and
// rolled up — the enrichment panel a monthly payout statement freezes at
// publish time (the reservation feed drifts afterwards; the snapshot never
// does). Unlike api/portal.js buildBookings (one page, booked_at buckets),
// this PAGINATES and buckets by stay overlap with the month: "what was
// earned in July" is a check-in/check-out question, not a booking-date one.

// Direct bookings are Samba bookings — the owner should see who brought them.
const CHANNEL_LABELS = {
  airbnb: 'Airbnb',
  'booking.com': 'Booking.com', booking: 'Booking.com',
  'trip.com': 'Trip.com', trip: 'Trip.com', ctrip: 'Trip.com',
  agoda: 'Agoda',
  direct: 'Samba', custom: 'Samba', hostex_direct: 'Samba', hostex: 'Samba',
};

const MS_DAY = 86400000;

async function fetchAllReservations(hostexId, stopBefore) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`https://api.hostex.io/v3/reservations?property_id=${hostexId}&per_page=100&page=${page}`, {
      headers: { 'Hostex-Access-Token': process.env.HOSTEX_TOKEN },
    });
    if (!r.ok) break;
    const batch = ((await r.json())?.data?.reservations) || [];
    all.push(...batch);
    if (batch.length < 100) break;
    // Feed is newest-booked-first: once a whole page was booked long before
    // the month we care about, older pages can't intersect it either.
    // 370-day margin covers long-lead bookings.
    if (batch.every(x => String(x.booked_at || '').slice(0, 10) < stopBefore)) break;
  }
  return all;
}

export async function buildMonthStats(units, period) {
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error('period must be YYYY-MM');
  const [y, mo] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  const monthStart = Date.UTC(y, mo - 1, 1);
  const monthEnd = Date.UTC(y, mo, 1);                 // exclusive
  const daysInMonth = Math.round((monthEnd - monthStart) / MS_DAY);
  const stopBefore = new Date(monthStart - 370 * MS_DAY).toISOString().slice(0, 10);

  const chOf = x => { const c = String(x.channel_type || '').toLowerCase(); return CHANNEL_LABELS[c] || (c ? c[0].toUpperCase() + c.slice(1) : 'Other'); };
  const netOf = x => Number(x.payment?.total_amount ?? ((x.rates?.total_rate?.amount || 0) - (x.rates?.total_commission?.amount || 0))) || 0;

  const out = { period, days_in_month: daysInMonth, units: {}, group: null };
  const roll = { nights_sold: 0, reservations: 0, net: 0, channels: {} };
  let unitCount = 0;

  for (const u of units) {
    if (!u.hostexId) continue;
    unitCount++;
    let resv;
    try { resv = await fetchAllReservations(u.hostexId, stopBefore); }
    catch { out.units[u.slug] = { error: 'hostex unavailable' }; continue; }

    let nights = 0, count = 0, net = 0;
    const channels = {};
    for (const x of resv) {
      if (x.status === 'cancelled') continue;
      const ci = Date.parse(String(x.check_in_date) + 'T00:00:00Z');
      const co = Date.parse(String(x.check_out_date) + 'T00:00:00Z');
      if (!isFinite(ci) || !isFinite(co) || co <= ci) continue;
      // Nights of this stay that fall inside the month.
      const overlap = Math.max(0, Math.round((Math.min(co, monthEnd) - Math.max(ci, monthStart)) / MS_DAY));
      if (!overlap) continue;
      count++;
      nights += overlap;
      channels[chOf(x)] = (channels[chOf(x)] || 0) + overlap;
      // Net revenue pro-rated to the month's share of the stay.
      const stayNights = Math.round((co - ci) / MS_DAY);
      net += stayNights ? netOf(x) * (overlap / stayNights) : 0;
    }
    const stat = {
      name: u.name || null,
      nights_sold: nights,
      occupancy_pct: Math.min(100, Math.round((nights / daysInMonth) * 100)),
      reservations: count,
      channels,
      adr: nights ? Math.round(net / nights) : null,
    };
    out.units[u.slug] = stat;
    roll.nights_sold += nights;
    roll.reservations += count;
    roll.net += net;
    for (const [k, v] of Object.entries(channels)) roll.channels[k] = (roll.channels[k] || 0) + v;
  }

  if (unitCount) {
    out.group = {
      nights_sold: roll.nights_sold,
      occupancy_pct: Math.min(100, Math.round((roll.nights_sold / (daysInMonth * unitCount)) * 100)),
      reservations: roll.reservations,
      channels: roll.channels,
      adr: roll.nights_sold ? Math.round(roll.net / roll.nights_sold) : null,
    };
  }
  return out;
}
