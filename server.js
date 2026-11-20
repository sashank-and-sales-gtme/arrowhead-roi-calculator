import http from 'node:http';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT) || 4173;
const WEBHOOK_URL = process.env.CLAY_WEBHOOK_URL || '';
const LEADS_FILE = join(ROOT, 'leads.jsonl');
const MAX_BODY_BYTES = 64 * 1024;

const PUBLIC_DIRS = ['web', 'engine', 'data'];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUYER_TYPES = new Set(['content-with-vendor', 'burnt-by-vendor', 'not-convinced']);

function validateLead(lead) {
  if (!lead || typeof lead !== 'object') return 'Body must be a JSON object';
  if (!EMAIL.test(lead?.contact?.email || '')) return 'A valid work email is required';
  if (!(lead?.contact?.company || '').trim()) return 'Company is required';
  if (!BUYER_TYPES.has(lead.buyerType)) return 'Unknown buyer type';
  return null;
}

async function handleLead(req, res) {
  let lead;
  try {
    lead = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, err.status || 400, err.status ? err.message : 'Body must be valid JSON');
  }
  const problem = validateLead(lead);
  if (problem) return send(res, 422, problem);

  const record = { ...lead, receivedAt: new Date().toISOString() };

  if (WEBHOOK_URL) {
    try {
      const upstream = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      if (!upstream.ok) return send(res, 502, `Webhook returned ${upstream.status}`);
      return send(res, 200, JSON.stringify({ delivered: 'webhook' }), TYPES['.json']);
    } catch (err) {
      return send(res, 502, `Webhook unreachable: ${err.message}`);
    }
  }

  await appendFile(LEADS_FILE, JSON.stringify(record) + '\n');
  return send(res, 200, JSON.stringify({ delivered: 'local-file' }), TYPES['.json']);
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/lead') {
    handleLead(req, res).catch((err) => send(res, 500, err.message));
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }
  send(res, 405, 'Method not allowed');
});

server.listen(PORT, () => {
  const target = WEBHOOK_URL ? 'your Clay webhook' : `${LEADS_FILE} (set CLAY_WEBHOOK_URL to send them to Clay)`;
  console.log(`Calculator running at http://localhost:${PORT}`);
  console.log(`Leads go to ${target}`);
});
