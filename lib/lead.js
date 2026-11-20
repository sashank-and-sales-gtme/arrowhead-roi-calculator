/** Shared lead validation and delivery, used by server.js locally and api/lead.js on Vercel. */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BUYER_TYPES = new Set(['content-with-vendor', 'burnt-by-vendor', 'not-convinced']);
export const MAX_BODY_BYTES = 64 * 1024;

export function validateLead(lead) {
  if (!lead || typeof lead !== 'object') return 'Body must be a JSON object';
  if (!EMAIL.test(lead?.contact?.email || '')) return 'A valid work email is required';
  if (!(lead?.contact?.company || '').trim()) return 'Company is required';
  if (!BUYER_TYPES.has(lead.buyerType)) return 'Unknown buyer type';
  return null;
}

/** Posts the lead to a Clay webhook. Returns { ok, status, message }. */
export async function forwardToWebhook(url, record) {
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!upstream.ok) return { ok: false, status: 502, message: `Webhook returned ${upstream.status}` };
    return { ok: true, status: 200, message: 'webhook' };
  } catch (err) {
    return { ok: false, status: 502, message: `Webhook unreachable: ${err.message}` };
  }
}
