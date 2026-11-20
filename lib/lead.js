/**
 * Shared lead intake, used by server.js locally and api/lead.js on Vercel.
 *
 * The endpoint is public, so it trusts nothing in the request:
 * - only same-origin JSON is accepted, which stops other sites posting leads from a visitor's browser;
 * - the body is size-capped before parsing and every string is length-capped before any regex runs;
 * - the record forwarded to Clay is rebuilt from known fields only, so extra or oversized
 *   fields never reach the CRM;
 * - text that a spreadsheet or Clay table would read as a formula is neutralised;
 * - a hidden honeypot field drops naive bot submissions without telling the bot.
 */

import { DEMO_LENDER } from '../data/demo-lender.js';

export const MAX_BODY_BYTES = 16 * 1024;
const MAX_EMAIL = 254;
const MAX_TEXT = 200;
const MAX_ABS_NUMBER = 1e13;
const WEBHOOK_TIMEOUT_MS = 8000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const BUYER_TYPES = new Set(['content-with-vendor', 'burnt-by-vendor', 'not-convinced']);
const HEADLINE_NUMBERS = [
  'collectionsToday', 'addedCollectionsVsVendor', 'pnlImpactVsVendor', 'pnlImpactAIOnly',
  'pnlImpactEscalation', 'surgeAttemptsUnworked', 'incumbentHangups10s',
];

/** Strips control characters, trims, caps length and defuses spreadsheet formulas. */
export function cleanText(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

const cleanNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_NUMBER ? value : null;

/** Copies only the fields the calculator has, with the types it uses. Labels come from the template. */
function cleanInputs(value, template) {
  if (Array.isArray(template)) {
    return template.map((t, i) => cleanInputs(Array.isArray(value) ? value[i] : undefined, t));
  }
  if (template && typeof template === 'object') {
    const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Object.fromEntries(Object.keys(template).map((k) => [k, cleanInputs(src[k], template[k])]));
  }
  if (typeof template === 'number') return cleanNumber(value);
  if (typeof template === 'boolean') return typeof value === 'boolean' ? value : template;
  return template;
}

/** Returns an error message for a lead that can't be accepted, or null. */
export function validateLead(lead) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return 'Body must be a JSON object';
  const email = lead?.contact?.email;
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !EMAIL.test(email)) return 'A valid work email is required';
  const company = lead?.contact?.company;
  if (typeof company !== 'string' || !company.trim() || company.length > MAX_TEXT) return 'Company is required';
  if (!BUYER_TYPES.has(lead.buyerType)) return 'Unknown buyer type';
  return null;
}

/** Builds the record sent onward from known fields only. */
export function buildRecord(lead) {
  const headline = lead.headline && typeof lead.headline === 'object' ? lead.headline : {};
  return {
    contact: { email: lead.contact.email.trim(), company: cleanText(lead.contact.company) },
    buyerType: lead.buyerType,
    currentMotion: cleanText(lead.currentMotion) || null,
    headline: {
      ...Object.fromEntries(HEADLINE_NUMBERS.map((k) => [k, cleanNumber(headline[k])])),
      humanBenchmarkIsHistorical: headline.humanBenchmarkIsHistorical === true,
    },
    inputs: cleanInputs(lead.inputs, DEMO_LENDER),
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Checks the request envelope and body. `headers` is a Headers-like object with get().
 * Returns { status, message } for a rejection, { drop: true } for a honeypot hit, or { record }.
 */
export function parseLeadRequest({ headers, bodyText, host }) {
  const type = (headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, message: 'Content-Type must be application/json' };

  const origin = headers.get('origin');
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* malformed origin is rejected below */ }
    if (!host || originHost !== host) return { status: 403, message: 'Cross-origin requests are not allowed' };
  }

  if (Buffer.byteLength(bodyText, 'utf8') > MAX_BODY_BYTES) return { status: 413, message: 'Payload too large' };

  let lead;
  try {
    lead = JSON.parse(bodyText);
  } catch {
    return { status: 400, message: 'Body must be valid JSON' };
  }
  if (lead && typeof lead === 'object' && typeof lead.website === 'string' && lead.website !== '') return { drop: true };

  const problem = validateLead(lead);
  if (problem) return { status: 422, message: problem };
  return { record: buildRecord(lead) };
}

/** Posts the lead to a Clay webhook. Returns { ok, status, message }; details are logged, not returned. */
export async function forwardToWebhook(url, record) {
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      console.error(`lead webhook returned ${upstream.status}`);
      return { ok: false, status: 502, message: 'Could not deliver the lead' };
    }
    return { ok: true, status: 200, message: 'webhook' };
  } catch (err) {
    console.error(`lead webhook unreachable: ${err.name}`);
    return { ok: false, status: 502, message: 'Could not deliver the lead' };
  }
}
