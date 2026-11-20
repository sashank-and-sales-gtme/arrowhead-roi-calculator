import { parseLeadRequest, forwardToWebhook, MAX_BODY_BYTES } from '../lib/lead.js';

/**
 * Vercel function for POST /api/lead.
 * Forwards to CLAY_WEBHOOK_URL when it is set in the Vercel project's environment
 * variables; otherwise the lead is written to the function logs.
 */
const text = (body, status, extra = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const json = (body) => Response.json(body, { headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(request) {
    if (request.method !== 'POST') return text('Method not allowed', 405, { Allow: 'POST' });

    const declared = Number(request.headers.get('content-length'));
    if (declared > MAX_BODY_BYTES) return text('Payload too large', 413);

    const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || new URL(request.url).host;
    const result = parseLeadRequest({ headers: request.headers, bodyText: await request.text(), host });
    if (result.status) return text(result.message, result.status);
    if (result.drop) return json({ delivered: 'log' });

    const webhook = process.env.CLAY_WEBHOOK_URL;
    if (webhook) {
      const sent = await forwardToWebhook(webhook, result.record);
      if (!sent.ok) return text(sent.message, sent.status);
      return json({ delivered: 'webhook' });
    }
    console.log(`lead ${JSON.stringify(result.record)}`);
    return json({ delivered: 'log' });
  },
};
