const { apiGet, mapWithConcurrency } = require('./wetravel');

const SEASON_END = process.env.SEASON_END || '2026-12-31';
const TARGET = Number(process.env.BOOKING_TARGET || 10);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);

// Corporate/charter departures aren't retail sales, so they'd distort the target.
// Also where a departure goes once it's been called off.
const EXCLUDED = new Set(
  (process.env.EXCLUDED_TRIP_UUIDS || '8612103268,9638755524')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// Departures that stay on the board, stamped CANCELLED.
const CANCELLED = new Set(
  (process.env.CANCELLED_TRIP_UUIDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

let cache = { at: 0, payload: null };

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim();

// Trip titles carry the departure dates and a season stamp, both of which the
// chart shows elsewhere. Strip them so the label is just the product.
function productName(title) {
  let name = String(title || '').trim();
  name = name.replace(/\s*-?\s*\/\s*\d{1,2}\s+[A-Za-z]+\.?\s*[-–]\s*\d{1,2}\s+[A-Za-z]+\.?\s*/g, ' ');
  name = name.replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*20\d{2}\b/gi, ' ');
  name = name.replace(/\b20\d{2}\b/g, ' ');
  name = name.replace(/\s*[-–|]\s*$/, '').replace(/^\s*[-–|]\s*/, '');
  name = name.replace(/\s*[-–]\s*/g, ' | ').replace(/\s*\|\s*/g, ' | ');
  name = name.replace(/\s+/g, ' ').trim();
  return name || String(title || '').trim();
}

function dayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// "Week 2 (06 Sep - 12 Sep)" carries no year, so anchor it to the trip it belongs
// to and roll forward when the range crosses New Year.
function weekDates(packageName, trip) {
  const m = String(packageName || '')
    .match(/\((\d{1,2})\s*([A-Za-z]{3,})\.?\s*[-–]\s*(\d{1,2})\s*([A-Za-z]{3,})\.?\s*\)/);
  const tripStart = new Date(trip.start_date);
  if (!m || Number.isNaN(tripStart.getTime())) {
    return { start: dayKey(trip.start_date), end: dayKey(trip.end_date) || dayKey(trip.start_date) };
  }

  const [, d1, mo1, d2, mo2] = m;
  const m1 = MONTHS[mo1.slice(0, 3).toLowerCase()];
  const m2 = MONTHS[mo2.slice(0, 3).toLowerCase()];
  if (m1 == null || m2 == null) {
    return { start: dayKey(trip.start_date), end: dayKey(trip.end_date) || dayKey(trip.start_date) };
  }

  let year = tripStart.getUTCFullYear();
  let start = new Date(Date.UTC(year, m1, Number(d1)));
  // A week reading months before its own trip belongs to the next year.
  if (start.getTime() < tripStart.getTime() - 45 * 864e5) {
    year += 1;
    start = new Date(Date.UTC(year, m1, Number(d1)));
  }
  let end = new Date(Date.UTC(year, m2, Number(d2)));
  if (end.getTime() < start.getTime()) end = new Date(Date.UTC(year + 1, m2, Number(d2)));

  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

async function listAllTrips() {
  const trips = [];
  for (let page = 1; page <= 10; page++) {
    const body = await apiGet(`/draft_trips?per_page=1000&page=${page}&exclude_payment_links=true`);
    trips.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return trips;
}

// Packages are the weeks people actually book, and they exist at zero sales —
// the only way an empty week still gets a bar.
async function fetchPackages(tripUuid) {
  return (await apiGet(`/draft_trips/${tripUuid}/packages`)).data || [];
}

async function fetchOrders(tripUuid) {
  const orders = [];
  for (let page = 1; page <= 20; page++) {
    const body = await apiGet(`/bookings/trips/${tripUuid}/bookings?page=${page}`);
    orders.push(...(body.data || []));
    if (!(body.pagination && body.pagination.has_next)) break;
  }
  return orders;
}

async function loadTrip(trip) {
  const [packages, orders] = await Promise.all([
    fetchPackages(trip.uuid).catch((err) => {
      console.error(`packages failed for ${trip.uuid}: ${err.message}`);
      return [];
    }),
    fetchOrders(trip.uuid).catch((err) => {
      console.error(`bookings failed for ${trip.uuid}: ${err.message}`);
      return null;
    }),
  ]);

  const tally = new Map();
  let activeTotal = 0;
  let cancelledTotal = 0;

  for (const order of orders || []) {
    activeTotal += order.active_count || 0;
    cancelledTotal += order.cancelled_count || 0;
    for (const pkg of order.packages || []) {
      const key = tidy(pkg.name);
      tally.set(key, (tally.get(key) || 0) + (pkg.quantity || 1));
    }
  }

  const weeks = packages.map((pkg) => {
    const label = tidy(pkg.name);
    return {
      id: `${trip.uuid}:${pkg.id}`,
      label,
      booked: tally.get(label) || 0,
      capacity: pkg.quantity == null ? null : Number(pkg.quantity),
      ...weekDates(label, trip),
    };
  });

  // Orders that never named a package are still real people. One week leaves only
  // one place they can go; several means say so rather than guess.
  const allocated = weeks.reduce((sum, w) => sum + w.booked, 0);
  const unallocated = Math.max(0, activeTotal - allocated);
  if (unallocated > 0 && weeks.length === 1) weeks[0].booked += unallocated;

  return {
    weeks,
    cancelledTotal,
    unallocated: unallocated > 0 && weeks.length !== 1 ? unallocated : 0,
    bookingsMissing: orders === null,
  };
}

async function build() {
  const todayKey = dayKey(new Date());
  const allTrips = await listAllTrips();
  const warnings = [];

  const candidates = allTrips
    .filter((trip) => {
      if (EXCLUDED.has(String(trip.uuid))) return false;
      const start = dayKey(trip.start_date);
      const end = dayKey(trip.end_date) || start;
      return start && end >= todayKey && start <= SEASON_END;
    })
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const loaded = await mapWithConcurrency(candidates, 4, (trip) => loadTrip(trip));

  // One card per departure, weeks nested inside it — that's the unit the team
  // asks about ("how many on this trip, and which week are they on?").
  const trips = [];
  candidates.forEach((trip, i) => {
    const data = loaded[i];

    // A trip WeTravel can't find bookings for isn't a sellable departure. Drop it
    // from the board, but say so rather than letting it vanish silently.
    if (data.bookingsMissing) {
      warnings.push({
        uuid: trip.uuid,
        title: trip.title,
        issue: 'WeTravel has no booking record for this trip (bookings endpoint returns not found)',
      });
      return;
    }

    // Only what's still ahead: a week that already ran isn't progress to track.
    const weeks = data.weeks
      .filter((w) => !(w.end && w.end < todayKey) && !(w.start && w.start > SEASON_END))
      .map((w) => ({
        id: w.id,
        label: w.label,
        start: w.start,
        end: w.end,
        booked: w.booked,
        capacity: w.capacity,
      }))
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    if (!weeks.length) return;

    if (data.unallocated) {
      warnings.push({
        uuid: trip.uuid,
        title: trip.title,
        issue: `${data.unallocated} booking(s) not assigned to any week`,
      });
    }

    trips.push({
      uuid: trip.uuid,
      name: productName(trip.title),
      title: trip.title,
      url: trip.url,
      destination: trip.destination || '',
      start: weeks[0].start,
      end: weeks[weeks.length - 1].end,
      totalBooked: weeks.reduce((sum, w) => sum + w.booked, 0),
      totalCapacity: weeks.every((w) => w.capacity == null)
        ? null
        : weeks.reduce((sum, w) => sum + (w.capacity || 0), 0),
      cancelledCount: data.cancelledTotal,
      cancelled: CANCELLED.has(String(trip.uuid)),
      weeks,
    });
  });

  trips.sort((a, b) =>
    (a.start || '').localeCompare(b.start || '') || a.name.localeCompare(b.name));

  const allWeeks = trips.flatMap((t) => t.weeks);

  return {
    asOf: new Date().toISOString(),
    today: todayKey,
    seasonEnd: SEASON_END,
    target: TARGET,
    totalBooked: allWeeks.reduce((sum, w) => sum + w.booked, 0),
    weekCount: allWeeks.length,
    weeksAtTarget: allWeeks.filter((w) => w.booked >= TARGET).length,
    trips,
    warnings,
  };
}

module.exports = async (req, res) => {
  try {
    const fresh = req.query && req.query.refresh === '1';
    if (!fresh && cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cache.payload);
    }

    const payload = await build();
    cache = { at: Date.now(), payload };
    res.setHeader('X-Cache', 'MISS');
    res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    // Stale numbers beat a blank wall display.
    if (cache.payload) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...cache.payload, stale: true, error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
};
