# WeTravel Pro booking dashboard, backed by Google Sheets

Bookings from WeTravel land as rows in a Google Sheet. The dashboard checks the sheet every 5 seconds and updates when a new row appears. Everything runs on Vercel, no separate server to manage.

## What's in here
- `api/webhook.js` — Vercel function WeTravel's webhook calls, appends a row to your sheet
- `api/bookings.js` — Vercel function the dashboard polls to read current rows
- `index.html` — the dashboard your team leaves open on a screen
- `package.json` — dependencies (just `googleapis`)

## Step 1: Create the Google Sheet
Make a new Google Sheet with a tab named exactly `Bookings`, and a header row:
```
Timestamp | Participant | Trip | Status | Amount
```
Copy the spreadsheet ID out of the URL, the long string between `/d/` and `/edit`.

## Step 2: Create a Google service account
This lets the webhook write to the sheet without anyone's personal login.
1. Go to console.cloud.google.com, create a project (or use an existing one)
2. Enable the "Google Sheets API" for that project
3. Go to Credentials, create a Service Account
4. Open the service account, go to Keys, create a new key, choose JSON, download it
5. Open that JSON file, you'll need the `client_email` and `private_key` values

## Step 3: Share the sheet with the service account
In your Google Sheet, click Share, and add the `client_email` from the JSON as an Editor.

## Step 4: Set environment variables in Vercel
In your Vercel project settings, add:
```
GOOGLE_SERVICE_ACCOUNT_EMAIL = the client_email from the JSON
GOOGLE_PRIVATE_KEY = the private_key from the JSON (keep the \n characters as-is)
SPREADSHEET_ID = the ID you copied from the sheet's URL
WETRAVEL_WEBHOOK_SECRET = optional, only if WeTravel gives you a signing secret
```

## Step 5: Deploy
Push this folder to a GitHub repo and import it into Vercel, or run `vercel` from this folder if you have the CLI installed. Vercel auto-detects the `api/` folder as serverless functions and serves `index.html` as the homepage.

## Step 6: Register the webhook with WeTravel
Once deployed, your webhook URL will be:
```
https://your-project.vercel.app/api/webhook
```
Add that in WeTravel Pro's Webhooks / Partner API settings as the endpoint for booking events.

## Two things to double check once real data is flowing
1. **Field names** — `api/webhook.js` guesses at field names like `participant_name`. Trigger a real test booking and check WeTravel's payload to confirm what they actually send, then adjust the `TODO` lines.
2. **Timing** — the dashboard checks every 5 seconds. If that's too slow or too chatty for your traffic, change `POLL_INTERVAL_MS` in `index.html`.

## Fees
- Google Sheets API: free within Google's standard quota, far more than this will ever use
- Vercel: free tier works for personal projects only, per their terms; for Nomuhub's use, the Pro plan (roughly $20/user/month) is the appropriate one, and this workload is small enough to stay well within its included usage
