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
