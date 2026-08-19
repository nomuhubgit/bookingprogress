const { build } = require('./booking-report');

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://bookingprogress.vercel.app';
const CRON_SECRET = process.env.CRON_SECRET || '';

// 08:00 in Muscat (UTC+4, no DST) is 04:00 UTC. One run per day now — the
// 22:00 boundary was removed when this dropped from twice- to once-daily.
const BOUNDARY_HOURS_UTC = [4];

// Cron can fire a little early or late; this keeps a slightly-off run anchored
// to the boundary it was meant to be, instead of picking the previous one.
const TOLERANCE_MS = 30 * 60 * 1000;

// Each run reports exactly the span since the previous scheduled run (now a
// full 24h, since there's only one run a day), so consecutive messages tile
// the day without overlapping. That's what stops a booking from ever being
// announced twice — no state to store, the windows simply never repeat.
function runWindow(nowMs) {
  const now = new Date(nowMs);
  const boundaries = [];
  for (let dayOffset = -2; dayOffset <= 1; dayOffset++) {
    for (const hour of BOUNDARY_HOURS_UTC) {
      boundaries.push(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour, 0, 0, 0
      ));
    }
  }
  boundaries.sort((a, b) => a - b);

  let index = -1;
  for (let i = 0; i < boundaries.length; i++) {
    if (boundaries[i] <= nowMs + TOLERANCE_MS) index = i;
  }
  // Fall back to a plain 24h look-back if something is badly out of range.
  if (index < 1) return { start: nowMs - 24 * 3600 * 1000, end: nowMs };

  return { start: boundaries[index - 1], end: boundaries[index] };
}

const omanDate = (ms) => new Date(ms).toLocaleDateString('en-GB', {
  timeZone: 'Asia/Muscat', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const omanTime = (ms) => new Date(ms).toLocaleTimeString('en-US', {
  timeZone: 'Asia/Muscat', hour: 'numeric', minute: '2-digit', hour12: true,
});

function buildMessage(payload, windowStart, windowEnd) {
  const byTrip = new Map();
  let total = 0;

  for (const e of payload.events || []) {
    if (e.x) continue;                 // charters stay out, as agreed
    if (!e.n) continue;                // cancelled-only orders aren't new bookings
    const at = Date.parse(e.at);
    if (!Number.isFinite(at) || at < windowStart || at >= windowEnd) continue;
    total += e.n;
    byTrip.set(e.t, (byTrip.get(e.t) || 0) + e.n);
  }

  const heading = omanDate(windowEnd);
  const since = `${omanTime(windowStart)} – ${omanTime(windowEnd)}`;

  const lines = [...byTrip.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([trip, n]) => `• ${trip} — *+${n}*`);

  const body = total
    ? `*${total} new booking${total === 1 ? '' : 's'}*\n${lines.join('\n')}`
    : '_No new bookings in this period._';

  return {
    text: total ? `${total} new booking${total === 1 ? '' : 's'} — ${heading}` : `No new bookings — ${heading}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: heading, emoji: true } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Bookings taken between *${since}* (Muscat time)` }] },
      { type: 'section', text: { type: 'mrkdwn', text: body } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `<${DASHBOARD_URL}|📊 Open Booking Progress dashboard>` } },
    ],
    total,
  };
}

module.exports = async (req, res) => {
  const nowMs = Date.now();
  const preview = req.query && req.query.preview === '1';

  // Vercel signs its cron calls with this header; without the check anyone who
  // learned the URL could spam the channel. Preview is read-only, so it's exempt.
  if (!preview && CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  try {
    const { start, end } = runWindow(nowMs);
    const payload = await build();
    const message = buildMessage(payload, start, end);

    if (preview) {
      return res.status(200).json({
        preview: true,
        windowStartUTC: new Date(start).toISOString(),
        windowEndUTC: new Date(end).toISOString(),
        windowOman: `${omanTime(start)} → ${omanTime(end)}`,
        total: message.total,
        wouldPost: { text: message.text, blocks: message.blocks },
      });
    }

    if (!SLACK_WEBHOOK_URL) {
      return res.status(500).json({ error: 'SLACK_WEBHOOK_URL is not set' });
    }

    const slackRes = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message.text, blocks: message.blocks }),
    });

    if (!slackRes.ok) {
      const detail = await slackRes.text();
      throw new Error(`Slack rejected the message (${slackRes.status}): ${detail}`);
    }

    res.status(200).json({ posted: true, total: message.total });
  } catch (err) {
    // Deliberately not posting failures to Slack — a broken upstream would
    // otherwise turn into repeated noise in the channel. Surfaced in Vercel logs.
    console.error('slack-notify failed:', err);
    res.status(500).json({ error: err.message });
  }
};

// Exported for testing the window maths and message shape without posting.
module.exports.runWindow = runWindow;
module.exports.buildMessage = buildMessage;
