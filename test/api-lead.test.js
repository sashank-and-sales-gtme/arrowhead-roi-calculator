import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/lead.js';

const post = (body) => handler.fetch(new Request('https://example.test/api/lead', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
const good = { contact: { email: 'head@lender.example', company: 'Kaveri Finance' }, buyerType: 'burnt-by-vendor' };

test('Vercel lead function accepts a valid lead and logs it without a webhook', async () => {
  delete process.env.CLAY_WEBHOOK_URL;
  const logs = [];
  const orig = console.log; console.log = (m) => logs.push(m);
  const res = await post(good);
  console.log = orig;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { delivered: 'log' });
  assert.ok(logs[0].includes('head@lender.example'));
});

test('Vercel lead function rejects bad input and wrong methods', async () => {
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post({ ...good, contact: { email: 'bad', company: 'X' } })).status, 422);
  assert.equal((await post({ ...good, buyerType: 'other' })).status, 422);
  const get = await handler.fetch(new Request('https://example.test/api/lead'));
  assert.equal(get.status, 405);
});

test('Vercel lead function forwards to the webhook when configured', async () => {
  process.env.CLAY_WEBHOOK_URL = 'https://webhook.example/clay';
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); };
  const res = await post(good);
  globalThis.fetch = origFetch;
  delete process.env.CLAY_WEBHOOK_URL;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { delivered: 'webhook' });
  assert.equal(sent[0].url, 'https://webhook.example/clay');
  assert.equal(sent[0].body.contact.company, 'Kaveri Finance');
});

/* ---------- security regressions ---------- */

const raw = (body, headers = {}) => handler.fetch(new Request('https://calc.example/api/lead', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'calc.example', ...headers }, body: JSON.stringify(body),
}));
const quiet = async (fn) => { const o = console.log, e = console.error; const logs = []; console.log = console.error = (m) => logs.push(m); try { return [await fn(), logs]; } finally { console.log = o; console.error = e; } };

test('rejects non-JSON content types, so other sites cannot send simple cross-site posts', async () => {
  const [res] = await quiet(() => raw(good, { 'Content-Type': 'text/plain' }));
  assert.equal(res.status, 415);
});

test('rejects posts from another origin and accepts the same origin', async () => {
  delete process.env.CLAY_WEBHOOK_URL;
  const [evil] = await quiet(() => raw(good, { Origin: 'https://evil.example' }));
  assert.equal(evil.status, 403);
  const [same] = await quiet(() => raw(good, { Origin: 'https://calc.example' }));
  assert.equal(same.status, 200);
});

test('a pathological email is rejected quickly instead of stalling the regex', async () => {
  const t = performance.now();
  const [res] = await quiet(() => raw({ ...good, contact: { email: 'a@' + 'a.'.repeat(7000) + '@', company: 'X' } }));
  assert.equal(res.status, 422);
  assert.ok(performance.now() - t < 100, 'email check should be bounded');
});

test('oversized bodies are refused', async () => {
  const [res] = await quiet(() => raw({ ...good, pad: 'x'.repeat(20 * 1024) }));
  assert.equal(res.status, 413);
});

test('only known fields are forwarded, and formula text is neutralised', async () => {
  process.env.CLAY_WEBHOOK_URL = 'https://webhook.example/clay';
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('ok'); };
  const [res] = await quiet(() => raw({
    ...good,
    contact: { email: 'head@lender.example', company: '=HYPERLINK("http://evil.example")', phone: 'x' },
    junk: { nested: true },
    inputs: { book: { buckets: [{ label: '<img src=x>', accounts: 5, avgOverdue: 'lots' }] }, extra: 1 },
    headline: { pnlImpactAIOnly: 1000, injected: 'x' },
    receivedAt: '1999-01-01',
  }));
  globalThis.fetch = origFetch;
  delete process.env.CLAY_WEBHOOK_URL;
  assert.equal(res.status, 200);
  const r = sent[0];
  assert.equal(r.junk, undefined);
  assert.equal(r.contact.phone, undefined);
  assert.equal(r.contact.company, `'=HYPERLINK("http://evil.example")`);
  assert.equal(r.inputs.extra, undefined);
  assert.equal(r.inputs.book.buckets[0].label, '1–30 DPD');
  assert.equal(r.inputs.book.buckets[0].accounts, 5);
  assert.equal(r.inputs.book.buckets[0].avgOverdue, null);
  assert.equal(r.headline.injected, undefined);
  assert.equal(r.headline.pnlImpactAIOnly, 1000);
  assert.notEqual(r.receivedAt, '1999-01-01');
});

test('honeypot submissions are dropped silently', async () => {
  delete process.env.CLAY_WEBHOOK_URL;
  const [res, logs] = await quiet(() => raw({ ...good, website: 'http://spam.example' }));
  assert.equal(res.status, 200);
  assert.equal(logs.length, 0);
});

test('webhook failures do not leak upstream details', async () => {
  process.env.CLAY_WEBHOOK_URL = 'https://webhook.example/clay';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:443'); };
  const [res] = await quiet(() => raw(good));
  globalThis.fetch = origFetch;
  delete process.env.CLAY_WEBHOOK_URL;
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('10.0.0.5'));
});
