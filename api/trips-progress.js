const { apiGet, mapWithConcurrency } = require('./wetravel');

const SEASON_END = process.env.SEASON_END || '2026-12-31';
const TARGET = Number(process.env.BOOKING_TARGET || 10);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 120000);

// Corporate/charter departures aren't retail sales, so they'd distort the target.
// Also the place to drop a departure once it's been called off.
const EXCLUDED = new Set(
  (process.env.EXCLUDED_TRIP_UUIDS || '8612103268,9638755524')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

// Departures that still belong on the board, stamped CANCELLED.
const CANCELLED = new Set(
  (process.env.CANCELLED_TRIP_UUIDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
);

let cache = { at: 0, payload: null };

// "ZNZ | Explore - /16 Aug - 22 Aug" is one product; the date tail is the week,
// which the package name already carries. Any trailing note is kept so an old
// copy doesn't silently merge into the live product's bars.
function productName(title) {
  const raw = String(title || '').trim();
  const m = raw.match(/^(.*?)\s*-?\s*\/\s*\d{1,2}\s+[A-Za-z]+\.?\s*-\s*\d{1,2}\s+[A-Za-z]+\.?\s*(\(.*\))?\s*$/);
  if (!m) return raw;
  return [m[1].trim(), (m[2] || '').trim()].filter(Boolean).join(' ');
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+\)/g, ')').trim();

function dayKey(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
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

// Packages are the weeks people actually book, and they exist even at zero sales —
// which is the only way an empty week still gets a bar.
async function fetchPackages(tripUuid) {
  const body = await apiGet(`/draft_trips/${tripUuid}/packages`);
  return body.data || [];
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
    // A trip can be listed but have no booking record at all; that's zero, not an outage.
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

  const weeks = packages.map((pkg) => ({
    id: `${trip.uuid}:${pkg.id}`,
    label: tidy(pkg.name),
    booked: tally.get(tidy(pkg.name)) || 0,
    capacity: pkg.quantity == null ? null : Number(pkg.quantity),
  }));

  // Orders that never named a package still represent real people. With a single
  // week there's only one place they can belong; with several, say so rather than guess.
  const allocated = weeks.reduce((sum, w) => sum + w.booked, 0);
  const unallocated = Math.max(0, activeTotal - allocated);
  if (unallocated > 0 && weeks.length === 1) {
    weeks[0].booked += unallocated;
  }

  return {
    weeks,
    activeTotal,
    cancelledTotal,
    unallocated: unallocated > 0 && weeks.length !== 1 ? unallocated : 0,
    bookingsUnavailable: orders === null,
  };
}

async function build() {
  const todayKey = dayKey(new Date());
  const allTrips = await listAllTrips();

  const inWindow = allTrips
    .filter((trip) => {
      if (EXCLUDED.has(String(trip.uuid))) return false;
      const start = dayKey(trip.start_date);
      const end = dayKey(trip.end_date) || start;
      return start && end >= todayKey && start <= SEASON_END;
    })
    .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));

  const loaded = await mapWithConcurrency(inWindow, 4, (trip) => loadTrip(trip));

  // One bar per bookable week, grouped under the product it belongs to.
  const groups = [];
  const byName = new Map();

  inWindow.forEach((trip, i) => {
    const data = loaded[i];
    const name = productName(trip.title);

    if (!byName.has(name)) {
      const group = { name, bars: [], firstStart: trip.start_date };
      byName.set(name, group);
      groups.push(group);
    }
    const group = byName.get(name);

    for (const week of data.weeks) {
      group.bars.push({
        id: week.id,
        label: week.label,
        booked: week.booked,
        capacity: week.capacity,
        tripUuid: trip.uuid,
        tripTitle: trip.title,
        tripStart: dayKey(trip.start_date),
        tripEnd: dayKey(trip.end_date),
        tripUrl: trip.url,
        cancelled: CANCELLED.has(String(trip.uuid)),
        cancelledCount: data.cancelledTotal,
        bookingsUnavailable: data.bookingsUnavailable,
      });
    }

    if (data.unallocated) {
      group.bars.push({
        id: `${trip.uuid}:unallocated`,
        label: 'Unassigned week',
        booked: data.unallocated,
        capacity: null,
        tripUuid: trip.uuid,
        tripTitle: trip.title,
        tripStart: dayKey(trip.start_date),
        tripEnd: dayKey(trip.end_date),
        tripUrl: trip.url,
        cancelled: CANCELLED.has(String(trip.uuid)),
        cancelledCount: data.cancelledTotal,
        bookingsUnavailable: data.bookingsUnavailable,
      });
    }
  });

  const withBars = groups.filter((g) => g.bars.length);

  return {
    asOf: new Date().toISOString(),
    seasonEnd: SEASON_END,
    target: TARGET,
    totalBooked: withBars.reduce((sum, g) => sum + g.bars.reduce((s, b) => s + b.booked, 0), 0),
    groups: withBars.map(({ name, bars }) => ({ name, bars })),
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
