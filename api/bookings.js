const { google } = require('googleapis');

async function getSheetsClient() {
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  return google.sheets({ version: 'v4', auth });
}

module.exports = async (req, res) => {
  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: 'Bookings!A:E',
    });

    const rows = result.data.values || [];
    // Row 1 is the header, skip it.
    const bookings = rows.slice(1).map((r) => ({
      time: r[0] || '',
      participantName: r[1] || '',
      tripName: r[2] || '',
      status: r[3] || '',
      amount: r[4] || '',
    })).reverse(); // newest first

    res.status(200).json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to read sheet' });
  }
};
