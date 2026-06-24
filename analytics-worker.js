// ─────────────────────────────────────────────────────────────────────────────
// Panoramic Building — Analytics Cloudflare Worker
// Proxies GA4 Data API + Google Search Console API using a service account.
// No browser sign-in required — data loads automatically for all admin users.
//
// Required Secrets (set in Cloudflare dashboard → Worker → Settings → Variables):
//   SERVICE_ACCOUNT_EMAIL  — e.g. panoramic-analytics@your-project.iam.gserviceaccount.com
//   PRIVATE_KEY            — the full "private_key" string from the service account JSON
//                            (include the -----BEGIN/END PRIVATE KEY----- lines)
// ─────────────────────────────────────────────────────────────────────────────

const GA_PROPERTY_ID = '543000260';
const SC_SITE_URL    = 'https://panoramicbuildingllc.com/';
const ALLOWED_ORIGINS = [
  'https://panoramicbuildingllc.com',
  'https://panoramic01.github.io',
  'http://127.0.0.1:5500',   // local dev
  'http://localhost'
];

// In-memory token cache (valid per worker instance, ~a few minutes warm)
let _cachedToken  = null;
let _tokenExpiry  = 0;

// ── JWT / token helpers ────────────────────────────────────────────────────

function pemToBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(arrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jsonB64(obj) {
  return btoa(JSON.stringify(obj))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedToken && now < _tokenExpiry - 60) return _cachedToken;

  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   env.SERVICE_ACCOUNT_EMAIL,
    scope: 'https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600
  };

  const sigInput = `${jsonB64(header)}.${jsonB64(payload)}`;
  const keyBuf   = pemToBuffer(env.PRIVATE_KEY);
  const key      = await crypto.subtle.importKey(
    'pkcs8', keyBuf,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
  const jwt = `${sigInput}.${b64url(sig)}`;

  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(data));

  _cachedToken = data.access_token;
  _tokenExpiry = now + (data.expires_in || 3600);
  return _cachedToken;
}

// ── GA4 helpers ────────────────────────────────────────────────────────────

async function gaReport(token, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA_PROPERTY_ID}:runReport`,
    {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error((e.error && e.error.message) || 'GA error ' + res.status);
  }
  return res.json();
}

function gaDates(range) {
  const days = range === '7' ? 7 : range === '30' ? 30 : 90;
  return {
    cur:  { startDate: days + 'daysAgo',         endDate: 'today' },
    prev: { startDate: (days * 2) + 'daysAgo',   endDate: (days + 1) + 'daysAgo' }
  };
}

// ── Data fetchers ──────────────────────────────────────────────────────────

async function fetchKPI(token, range) {
  const { cur, prev } = gaDates(range);
  const metrics = [
    { name: 'sessions' }, { name: 'activeUsers' },
    { name: 'screenPageViews' }, { name: 'averageSessionDuration' }
  ];
  const [curR, prevR] = await Promise.all([
    gaReport(token, { dateRanges: [cur],  metrics }),
    gaReport(token, { dateRanges: [prev], metrics })
  ]);
  const empty = [0, 0, 0, 0];
  const cv = (curR.rows?.[0]?.metricValues  || []).map(v => +v.value);
  const pv = (prevR.rows?.[0]?.metricValues || []).map(v => +v.value);
  return {
    sessions:    cv[0] || 0, pSessions:    pv[0] || 0,
    users:       cv[1] || 0, pUsers:       pv[1] || 0,
    pageviews:   cv[2] || 0, pPageviews:   pv[2] || 0,
    avgDuration: cv[3] || 0, pAvgDuration: pv[3] || 0
  };
}

async function fetchPages(token, range) {
  const { cur } = gaDates(range);
  const data = await gaReport(token, {
    dateRanges: [cur],
    dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
    metrics:    [{ name: 'screenPageViews' }],
    orderBys:   [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 6
  });
  return (data.rows || []).map(row => ({
    label: row.dimensionValues[0].value
      .replace(/ \| Panoramic Building( LLC)?/, '').trim() || row.dimensionValues[1].value,
    path:  row.dimensionValues[1].value,
    views: +row.metricValues[0].value
  }));
}

async function fetchSources(token, range) {
  const { cur } = gaDates(range);
  const data = await gaReport(token, {
    dateRanges: [cur],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics:    [{ name: 'sessions' }],
    orderBys:   [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 6
  });
  const rows  = data.rows || [];
  const total = rows.reduce((s, r) => s + +r.metricValues[0].value, 0) || 1;
  return rows.map(row => ({
    name:     row.dimensionValues[0].value,
    sessions: +row.metricValues[0].value,
    pct:      Math.round(+row.metricValues[0].value / total * 100)
  }));
}

async function fetchDevices(token, range) {
  const { cur } = gaDates(range);
  const data = await gaReport(token, {
    dateRanges: [cur],
    dimensions: [{ name: 'deviceCategory' }],
    metrics:    [{ name: 'sessions' }],
    orderBys:   [{ metric: { metricName: 'sessions' }, desc: true }]
  });
  const rows  = data.rows || [];
  const total = rows.reduce((s, r) => s + +r.metricValues[0].value, 0) || 1;
  return rows.map(row => ({
    name:     row.dimensionValues[0].value,
    sessions: +row.metricValues[0].value,
    pct:      Math.round(+row.metricValues[0].value / total * 100)
  }));
}

async function fetchSearch(token, range) {
  const days  = range === '7' ? 7 : range === '30' ? 30 : 90;
  const end   = new Date(); end.setDate(end.getDate() - 3); // SC has ~3-day lag
  const start = new Date(end); start.setDate(start.getDate() - days);
  const fmt   = d => d.toISOString().slice(0, 10);

  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SC_SITE_URL)}/searchAnalytics/query`,
    {
      method:  'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: ['query'], rowLimit: 8 })
    }
  );
  if (!res.ok) return null; // SC not yet verified — just omit
  const data = await res.json();
  return (data.rows || []).map(row => ({
    query: row.keys[0], clicks: row.clicks, impressions: row.impressions, position: row.position
  }));
}

// ── Main handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

    const corsHeaders = {
      'Access-Control-Allow-Origin':  corsOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type':                 'application/json',
      'Cache-Control':                'no-store'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url   = new URL(request.url);
    const range = url.searchParams.get('range') || '7';

    try {
      const token = await getAccessToken(env);

      const [kpi, pages, sources, devices, search] = await Promise.allSettled([
        fetchKPI(token, range),
        fetchPages(token, range),
        fetchSources(token, range),
        fetchDevices(token, range),
        fetchSearch(token, range)
      ]);

      const result = {
        kpi:     kpi.status     === 'fulfilled' ? kpi.value     : null,
        pages:   pages.status   === 'fulfilled' ? pages.value   : [],
        sources: sources.status === 'fulfilled' ? sources.value : [],
        devices: devices.status === 'fulfilled' ? devices.value : [],
        search:  search.status  === 'fulfilled' ? search.value  : null,
        errors:  [kpi, pages, sources, devices, search]
          .filter(r => r.status === 'rejected')
          .map(r => r.reason?.message)
      };

      return new Response(JSON.stringify(result), { headers: corsHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
