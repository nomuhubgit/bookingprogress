// Shared helper for WeTravel's Partner API.
//
// The "Partner API key" from Account > Profile is a *refresh* token. It isn't
// accepted by the data endpoints directly, it's exchanged for an access token
// that lasts an hour, and that's what the rest of the calls carry.

const API_BASE = process.env.WETRAVEL_API_BASE || 'https://api.wetravel.com/v2';

// Warm serverless instances reuse this, so we're not issuing a token per request.
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const refreshToken = process.env.WETRAVEL_API_KEY;
  if (!refreshToken) throw new Error('WETRAVEL_API_KEY is not set');

  const res = await fetch(`${API_BASE}/auth/tokens/access`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  }

  const body = await res.json();
  const token = body.access_token || (body.data && body.data.access_token);
  if (!token) throw new Error('token exchange returned no access_token');

  // Refresh a little before the hour is up so a call never races expiry.
  tokenCache = { token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return token;
}

async function apiGet(path, attempt = 0) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // 200 requests/min across all endpoints, so back off instead of hammering.
  if (res.status === 429 && attempt < 3) {
    const waitMs = Number(res.headers.get('retry-after') || 2) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return apiGet(path, attempt + 1);
  }

  // Token expired mid-flight: drop it and try once more with a fresh one.
  if (res.status === 401 && attempt < 1) {
    tokenCache = { token: null, expiresAt: 0 };
    return apiGet(path, attempt + 1);
  }

  if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// One booking call per trip would burst past the rate limit, so run a few at a time.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = { apiGet, mapWithConcurrency, API_BASE };
