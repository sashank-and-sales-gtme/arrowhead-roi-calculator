import http from 'node:http';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { parseLeadRequest, forwardToWebhook, MAX_BODY_BYTES } from './lib/lead.js';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
// Listen on this machine only unless HOST says otherwise (e.g. HOST=0.0.0.0 to share on a LAN).
const HOST = process.env.HOST || '127.0.0.1';
const WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL || '';
const LEADS_FILE = join(ROOT, 'leads.jsonl');

const PUBLIC_DIRS = ['web', 'engine', 'data'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// Same policy as vercel.json, minus upgrade-insecure-requests, which would break plain-http localhost.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Static files are gzipped once and kept in memory, keyed by path and modified time.
const fileCache = new Map();

async function loadStatic(filePath) {
  const { mtimeMs } = await stat(filePath);
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  const raw = await readFile(filePath);
  const entry = {
    mtimeMs,
    raw,
    gzip: gzipSync(raw, { level: 9 }),
    etag: `"${createHash('sha1').update(raw).digest('base64url').slice(0, 20)}"`,
  };
  fileCache.set(filePath, entry);
  return entry;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname === '/' ? '/web/index.html' : url.pathname;
  const filePath = normalize(join(ROOT, path));
  const allowed = PUBLIC_DIRS.some((dir) => filePath.startsWith(join(ROOT, dir) + '/'));
  if (!allowed) return send(res, 404, 'Not found');
  let file;
  try {
    file = await loadStatic(filePath);
  } catch {
    return send(res, 404, 'Not found');
  }
  // Browsers revalidate on each visit and get a tiny 304 when nothing changed.
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    ETag: file.etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = acceptsGzip ? file.gzip : file.raw;
  if (acceptsGzip) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLead(req, res) {
  let bodyText;
  try {
    bodyText = await readBody(req);
  } catch (err) {
    return send(res, err.status || 400, err.status ? err.message : 'Could not read the request body');
  }
  const headers = { get: (name) => req.headers[name.toLowerCase()] ?? null };
  const result = parseLeadRequest({ headers, bodyText, host: req.headers.host });
  if (result.status) return send(res, result.status, result.message);
  if (result.drop) return send(res, 200, JSON.stringify({ delivered: 'local-file' }), TYPES['.json']);
  const { record } = result;

  if (WEBHOOK_URL) {
    const result = await forwardToWebhook(WEBHOOK_URL, record);
    if (!result.ok) return send(res, result.status, result.message);
    return send(res, 200, JSON.stringify({ delivered: 'webhook' }), TYPES['.json']);
  }

  await appendFile(LEADS_FILE, JSON.stringify(record) + '\n');
  return send(res, 200, JSON.stringify({ delivered: 'local-file' }), TYPES['.json']);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/lead') {
    handleLead(req, res).catch((err) => {
      console.error('lead handler failed:', err);
      if (!res.headersSent) send(res, 500, 'Something went wrong');
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res).catch((err) => {
      console.error('static handler failed:', err.message);
      if (!res.headersSent) send(res, 400, 'Bad request');
    });
    return;
  }
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  const target = WEBHOOK_URL ? 'your Clay webhook' : `${LEADS_FILE} (set CLAY_WEBHOOK_URL to send them to Clay)`;
  console.log(`Calculator running at http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Leads go to ${target}`);
});
