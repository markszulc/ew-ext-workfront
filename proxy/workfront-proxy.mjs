#!/usr/bin/env node
/**
 * Minimal dev proxy for the Workfront side-panel plugin. Zero dependencies (Node 20+).
 *
 *   WF_HOST=https://markszulc.my.workfront.com node proxy/workfront-proxy.mjs
 *
 * Env:
 *   WF_HOST          Workfront base URL (required). Requests can only go here.
 *   WF_API_KEY       Optional. If set, requests use this key instead of the caller's
 *                    Bearer token — every caller then acts as the key's owner, so
 *                    use it for local development only.
 *   ALLOWED_ORIGINS  Comma-separated origins allowed via CORS
 *                    (default: http://localhost:3000, https://da.live, https://markszulc.github.io, *.aem.page, *.aem.live).
 *   PORT             Default 8787.
 */
import http from 'node:http';

const { WF_HOST, WF_API_KEY, PORT = 8787 } = process.env;
if (!WF_HOST) {
  console.error('Set WF_HOST, e.g. WF_HOST=https://markszulc.my.workfront.com');
  process.exit(1);
}
const target = new URL(WF_HOST.startsWith('http') ? WF_HOST : `https://${WF_HOST}`);
const allowed = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,https://da.live,https://markszulc.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);
const AEM_ORIGIN = /^https:\/\/[a-z0-9-]+--[a-z0-9-]+--[a-z0-9-]+\.aem\.(page|live)$/;

function corsHeaders(origin) {
  if (!origin || !(allowed.includes(origin) || AEM_ORIGIN.test(origin))) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type,Accept,X-Workfront-Host',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

const server = http.createServer(async (req, res) => {
  const cors = corsHeaders(req.headers.origin);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors).end();
    return;
  }
  const inUrl = new URL(req.url, 'http://proxy');
  if (!inUrl.pathname.startsWith('/attask/api/')) {
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Not found' } }));
    return;
  }

  const outUrl = new URL(inUrl.pathname + inUrl.search, target);
  const headers = { Accept: 'application/json' };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  if (WF_API_KEY) {
    outUrl.searchParams.set('apiKey', WF_API_KEY);
  } else if (req.headers.authorization) {
    headers.Authorization = req.headers.authorization;
  } else {
    res.writeHead(401, { ...cors, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: 'Missing Authorization header' } }));
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  try {
    const resp = await fetch(outUrl, { method: req.method, headers, body });
    const text = await resp.text();
    res.writeHead(resp.status, { ...cors, 'Content-Type': resp.headers.get('content-type') || 'application/json' });
    res.end(text);
    console.info(`${req.method} ${inUrl.pathname} -> ${resp.status}`);
  } catch (e) {
    res.writeHead(502, { ...cors, 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: { message: `Proxy error: ${e.message}` } }));
  }
});

server.listen(PORT, () => {
  console.info(`Workfront proxy on http://localhost:${PORT} -> ${target.origin}${WF_API_KEY ? ' (API key mode)' : ''}`);
});
