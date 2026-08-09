const { google } = require('googleapis');
const crypto = require('crypto');

// TODO: confirm the real header name WeTravel uses for signing, and set WETRAVEL_WEBHOOK_SECRET in Vercel env vars.
function isValidSignature(req) {
  const secret = process.env.WETRAVEL_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured yet, skip check for now
  const signature = req.headers['x-wetravel-signature'];
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(req.body)).digest('hex');
  return signature === expected;
}

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return google.sheets({ version: 'v4', auth });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');
  if (!isValidSignature(req)) return res.status(401).send('invalid signature');

  const payload = req.body || {};

  // TODO: adjust these field paths once you see a real payload from WeTravel's dashboard/docs.
  const row = [
    new Date().toISOString(),
    payload.participant_name || payload.customer_name || 'Unknown participant',
    payload.trip_name || payload.trip?.title || 'Unknown trip',
    payload.status || payload.event || 'booked',
    payload.amount || payload.total_paid || '',
  ];

  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Bookings!A:E',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
    res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    res.status(500).send('failed to write to sheet');
  }
};
