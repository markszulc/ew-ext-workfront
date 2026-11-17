/*
 * Workfront proxy for the Experience Workspace side-panel plugin (Adobe App Builder web action).
 *
 * The panel calls  {actionUrl}/attask/api/v19.0/...  with the author's IMS token.
 * This action:
 *   1. checks the IMS token with IMS and gets the author's email,
 *   2. optionally checks the email domain against ALLOWED_EMAIL_DOMAINS,
 *   3. calls WF_HOST as that author, so Workfront applies the author's own permissions,
 *   4. returns the Workfront response with CORS headers for allowed origins.
 *
 * WF_AUTH_STRATEGY:
 *   - "impersonate" (default): log in to Workfront as the author with an admin API key
 *     (POST /login?username=<email>&apiKey=<WF_ADMIN_API_KEY>) and use the returned sessionID.
 *   - "passthrough": forward the IMS bearer token to Workfront. Use this only if your Workfront
 *     instance accepts Adobe IMS tokens.
 */

const IMS_PROFILE_URL = 'https://ims-na1.adobelogin.com/ims/profile/v1';
const SESSION_TTL_MS = 10 * 60 * 1000;
const AEM_ORIGIN = /^https:\/\/[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(page|live)$/;
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

// Cached per warm container. Keys are the IMS token (for the profile) or the email (for the session).
const profileCache = new Map();
const sessionCache = new Map();

function corsHeaders(origin, allowedList) {
  if (!origin || !(allowedList.includes(origin) || AEM_ORIGIN.test(origin))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Accept,X-Workfront-Host',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function json(statusCode, cors, message) {
  return {
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: { error: { message } },
  };
}

function cached(map, key) {
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  map.delete(key);
  return undefined;
}

async function getImsProfile(token, fetchImpl) {
  const hit = cached(profileCache, token);
  if (hit) return hit;
  const resp = await fetchImpl(IMS_PROFILE_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) return null;
  const profile = await resp.json();
  profileCache.set(token, { value: profile, expires: Date.now() + SESSION_TTL_MS });
  return profile;
}

async function wfLogin(username, { host, version, adminKey, fetchImpl }) {
  const url = new URL(`/attask/api/${version}/login`, host);
  url.searchParams.set('username', username);
  url.searchParams.set('apiKey', adminKey);
  const resp = await fetchImpl(url, { method: 'POST', headers: { Accept: 'application/json' } });
  const data = await resp.json().catch(() => ({}));
  const sessionID = data?.data?.sessionID;
  return sessionID ? { sessionID } : { error: data?.error?.message || `HTTP ${resp.status}` };
}

// The author's Workfront username may differ from their IMS email, so look it up by email address.
async function findUsername(email, { host, version, adminKey, fetchImpl }) {
  const url = new URL(`/attask/api/${version}/user/search`, host);
  url.searchParams.set('emailAddr', email);
  url.searchParams.set('emailAddr_Mod', 'cieq');
  url.searchParams.set('isActive', 'true');
  url.searchParams.set('fields', 'username');
  url.searchParams.set('$$LIMIT', '2');
  url.searchParams.set('apiKey', adminKey);
  const resp = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP ${resp.status}`;
    return { error: resp.status === 401 || /not currently logged in/i.test(msg) ? `Workfront rejected WF_ADMIN_API_KEY (invalid, expired or not deployed): ${msg}` : msg };
  }
  const users = data?.data || [];
  if (users.length !== 1) return { error: users.length ? 'more than one active user has this email' : 'no active user has this email' };
  return { username: users[0].username };
}

async function getWorkfrontSession(email, opts) {
  const hit = cached(sessionCache, email);
  if (hit) return { sessionID: hit };
  let result = await wfLogin(email, opts);
  if (!result.sessionID) {
    const found = await findUsername(email, opts);
    if (found.username && found.username.toLowerCase() !== email) {
      result = await wfLogin(found.username, opts);
    } else {
      result = { error: `login failed (${result.error}); user lookup: ${found.error || 'username is the same as the email'}` };
    }
  }
  if (result.sessionID) sessionCache.set(email, { value: result.sessionID, expires: Date.now() + SESSION_TTL_MS });
  return result;
}

function decodeBody(raw, headers) {
  if (!raw) return undefined;
  const type = headers['content-type'] || '';
  if (type.includes('json') && raw.trim().startsWith('{')) return raw;
  // raw-http web actions base64-encode bodies they consider binary.
  return Buffer.from(raw, 'base64').toString('utf8');
}

async function main(params, { fetchImpl = fetch } = {}) {
  const headers = params.__ow_headers || {};
  const method = (params.__ow_method || 'get').toUpperCase();
  const path = params.__ow_path || '';
  const allowed = (params.ALLOWED_ORIGINS || 'http://localhost:3000,https://da.live,https://markszulc.github.io')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const cors = corsHeaders(headers.origin, allowed);

  if (method === 'OPTIONS') return { statusCode: 204, headers: cors };
  if (!METHODS.includes(method)) return json(405, cors, 'Method not allowed');
  if (!/^\/attask\/api\/v\d+(\.\d+)?\/[A-Za-z0-9/_.-]*$/.test(path)) return json(404, cors, 'Not found');
  if (!params.WF_HOST) return json(500, cors, 'WF_HOST is not configured');

  const auth = headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json(401, cors, 'Missing IMS token');

  const profile = await getImsProfile(token, fetchImpl);
  const email = (profile?.email || '').toLowerCase();
  if (!email) return json(401, cors, 'Invalid or expired IMS token');

  const domains = (params.ALLOWED_EMAIL_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (domains.length && !domains.includes(email.split('@')[1])) {
    return json(403, cors, `${email} is not allowed to use this proxy`);
  }

  const host = new URL(params.WF_HOST.startsWith('http') ? params.WF_HOST : `https://${params.WF_HOST}`);
  const version = path.split('/')[3];
  const outUrl = new URL(path, host);
  if (params.__ow_query) outUrl.search = params.__ow_query;
  ['apiKey', 'sessionID', 'username', 'password'].forEach((k) => outUrl.searchParams.delete(k));

  const outHeaders = { Accept: 'application/json' };
  if (headers['content-type']) outHeaders['Content-Type'] = headers['content-type'];

  if ((params.WF_AUTH_STRATEGY || 'impersonate') === 'passthrough') {
    outHeaders.Authorization = `Bearer ${token}`;
  } else {
    if (!params.WF_ADMIN_API_KEY) return json(500, cors, 'WF_ADMIN_API_KEY is not configured');
    const { sessionID, error } = await getWorkfrontSession(email, {
      host, version, adminKey: params.WF_ADMIN_API_KEY, fetchImpl,
    });
    if (!sessionID) return json(403, cors, `Couldn't sign in to Workfront as ${email}: ${error}`);
    outHeaders.sessionID = sessionID;
  }

  try {
    const resp = await fetchImpl(outUrl, {
      method,
      headers: outHeaders,
      body: method === 'GET' ? undefined : decodeBody(params.__ow_body, headers),
    });
    if (resp.status === 401) sessionCache.delete(email);
    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: { ...cors, 'Content-Type': resp.headers.get('content-type') || 'application/json' },
      body: text,
    };
  } catch (e) {
    return json(502, cors, `Could not reach Workfront: ${e.message}`);
  }
}

exports.main = main;
