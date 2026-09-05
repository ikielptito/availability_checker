// Stays, with their edges intact.
//
// Everything else in this codebase flattens Hostex reservations into a Set of
// booked dates, because the question was always "is this villa free on the
// 14th". Housekeeping asks the opposite question: WHEN does someone leave,
// when does the next one arrive, and how long was the place empty in between.
// That information is destroyed by the flattening, so this module keeps it.
//
// One trap worth naming: Hostex's check_out_date is EXCLUSIVE — a stay of
// 1-5 September has check_out_date 2026-09-05 and the villa is free that day.
// The clean therefore belongs ON the checkout date, not the day after.
//
// Catalog units only. Custom listings belong to owners who list with us but
// do not necessarily buy cleaning, and generating tasks for a villa nobody
// asked us to service would send a housekeeper to someone else's house.

import { UNITS } from './catalog.js';
import { fetchAllReservations } from './month-stats.js';

const MS_DAY = 86400000;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / MS_DAY);

// Cancelled and denied reservations still come back from the feed, and
// cleaning for a guest who never arrives is exactly the waste this is meant
// to stop. Anything not obviously dead counts as a real stay: Hostex has
// added status values before, and skipping a clean because of an unfamiliar
// word is worse than an occasional wasted visit.
const DEAD = /cancel|denied|declined|rejected/i;
const isLive = (r) => !DEAD.test(String(r.status || ''));

export function staysFrom(reservations) {
  return (reservations || [])
    .filter(isLive)
    .map(r => ({
      check_in: String(r.check_in_date || '').slice(0, 10),
      check_out: String(r.check_out_date || '').slice(0, 10),
      channel: r.channel_type || null,
      status: r.status || null,
      // Hostex names the guest on the reservation; the records library shows
      // it so a handover reads "before Aleksandr, 4–12 Sep" rather than a date.
      guest: r.guest_name || r.guest?.name || null,
    }))
    .filter(s => s.check_in && s.check_out && s.check_out > s.check_in)
    .map(s => ({ ...s, nights: dayDiff(s.check_in, s.check_out) }))
    .sort((a, b) => a.check_in.localeCompare(b.check_in));
}

// How long the villa stood empty before each arrival, and whether someone
// leaves and someone else arrives on the same day. Both are derived here so
// the scheduler on the CRM side reads one shape and holds no Hostex quirks.
export function annotate(stays) {
  return stays.map((s, i) => {
    const prev = stays[i - 1];
    const next = stays[i + 1];
    return {
      ...s,
      // Previous checkout is exclusive, so an arrival the same day means
      // zero vacant days and a same-day turnover.
      vacant_days_before: prev ? Math.max(0, dayDiff(prev.check_out, s.check_in)) : null,
      vacant_days_after: next ? Math.max(0, dayDiff(s.check_out, next.check_in)) : null,
      same_day_turnover: !!(prev && prev.check_out === s.check_in),
    };
  });
}

export async function buildTurnovers({ from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(from)) ? from
    : new Date(Date.now() - 30 * MS_DAY).toISOString().slice(0, 10);
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? to
    : new Date(Date.now() + 60 * MS_DAY).toISOString().slice(0, 10);
  // Reach back a year so the vacancy before a long-empty villa's next
  // arrival is measured against a real previous stay, not against nothing.
  const stopBefore = new Date(Date.parse(fromDate) - 370 * MS_DAY).toISOString().slice(0, 10);

  // Four at a time. Serially this was 14 round trips to Hostex on every
  // cache miss — 15 to 30 seconds inside a 60-second function budget, on an
  // hourly cron. Four is deliberately conservative: Hostex publishes no rate
  // limit, and a schedule that is a few seconds slower beats one that starts
  // getting throttled.
  const one = async (u) => {
    let stays = [];
    try {
      stays = annotate(staysFrom(await fetchAllReservations(u.hostexId, stopBefore)));
    } catch { /* one unit's feed failing must not blank the whole schedule */ }
    return {
      slug: u.slug,
      name: u.name,
      hostex_id: u.hostexId,
      // Only what touches the window, plus the stay immediately before it so
      // the caller can still see the vacancy leading into the first arrival.
      stays: stays.filter(s => s.check_out >= stopBefore && s.check_in <= toDate),
    };
  };

  const units = [];
  for (let i = 0; i < UNITS.length; i += 4) {
    units.push(...await Promise.all(UNITS.slice(i, i + 4).map(one)));
  }
  return { from: fromDate, to: toDate, today, units };
}
