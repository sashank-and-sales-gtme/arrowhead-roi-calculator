import { validateLead, forwardToWebhook, MAX_BODY_BYTES } from '../lib/lead.js';

/**
 * Vercel function for POST /api/lead.
 * Forwards to CLAY_WEBHOOK_URL when it is set in the Vercel project's environment
 * variables; otherwise the lead is written to the function logs.
 */
export default {
  async fetch(request) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return new Response('Payload too large', { status: 413 });

    let lead;
    try {
      lead = JSON.parse(text);
    } catch {
      return new Response('Body must be valid JSON', { status: 400 });
    }
    const problem = validateLead(lead);
    if (problem) return new Response(problem, { status: 422 });

    const record = { ...lead, receivedAt: new Date().toISOString() };
    const webhook = process.env.CLAY_WEBHOOK_URL;
    if (webhook) {
      const result = await forwardToWebhook(webhook, record);
      if (!result.ok) return new Response(result.message, { status: result.status });
      return Response.json({ delivered: 'webhook' });
    }
    console.log(`lead ${JSON.stringify(record)}`);
    return Response.json({ delivered: 'log' });
  },
};
