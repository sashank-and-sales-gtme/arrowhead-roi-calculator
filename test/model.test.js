import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runModel, validateInputs } from '../engine/model.js';
import { DEMO_LENDER } from '../data/demo-lender.js';

const clone = (x) => structuredClone(x);
const close = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

test('today collections blend human and incumbent rates by share', () => {
  const r = runModel(DEMO_LENDER);
  // 1-30: 540,000,000 x (0.6 x 0.75 + 0.4 x 0.68) = 389,880,000
  // 31-60: 280,000,000 x (0.6 x 0.40 + 0.4 x 0.35) = 106,400,000
  // 61-90: 144,000,000 x (0.6 x 0.20 + 0.4 x 0.15) = 25,920,000
  close(r.today.collections, 389880000 + 106400000 + 25920000);
});

test('AI-only applies the collection lift to the human benchmark only', () => {
  const r = runModel(DEMO_LENDER);
  // 540M x 0.90 + 280M x 0.48 + 144M x 0.24
  close(r.aiOnly.collections.total, 486000000 + 134400000 + 34560000);
});

test('connection lift never changes collections', () => {
  const a = clone(DEMO_LENDER);
  const b = clone(DEMO_LENDER);
  b.arrowhead.connectionLift = 0.9;
  const ra = runModel(a);
  const rb = runModel(b);
  close(ra.aiOnly.collections.total, rb.aiOnly.collections.total);
  close(ra.aiEscalation.collections.total, rb.aiEscalation.collections.total);
});

test('AI-only cost is connected minutes x all-in rate plus retained seats', () => {
  const r = runModel(DEMO_LENDER);
  // attempts 656,000 x 0.45 x 2.5 min x 3.75, plus all 60 seats kept
  close(r.aiOnly.cost.arrowhead, 656000 * 0.45 * 2.5 * 3.75);
  close(r.aiOnly.cost.total, 656000 * 0.45 * 2.5 * 3.75 + 60 * 32000);
  const inp = clone(DEMO_LENDER);
  inp.arrowhead.seatsReleasedShare = 1;
  close(runModel(inp).aiOnly.cost.total, 656000 * 0.45 * 2.5 * 3.75);
});

test('escalated calls collect at the human rate minus transfer drop-off', () => {
  const r = runModel(DEMO_LENDER);
  close(r.aiEscalation.multiplier, 0.9 * 1.2 + 0.1 * 0.75);
});

test('escalation cost adds transfer leg on lender telco and surge-staffed queue seats', () => {
  const inp = clone(DEMO_LENDER);
  inp.arrowhead.seatsReleasedShare = 1;
  const r = runModel(inp);
  const connects = 656000 * 0.45;
  const handled = connects * 0.1 * 0.75;
  const surgePerDay = (handled * 0.5) / 8;
  const seats = Math.ceil((surgePerDay * 3.5) / (11 * 60 * 0.65));
  assert.equal(r.aiEscalation.queueSeatsSurge, seats);
  close(r.aiEscalation.cost.transferLeg, handled * 3.5 * 0.6);
  close(r.aiEscalation.cost.extraQueueSeats, seats * 32000);
  const kept = runModel(DEMO_LENDER);
  assert.equal(kept.aiEscalation.extraQueueSeats, 0);
});

test('collection rate is capped at 100% of overdue', () => {
  const inp = clone(DEMO_LENDER);
  inp.book.buckets[0].humanCollectionRate = 0.95;
  const r = runModel(inp);
  assert.equal(r.aiOnly.collections.perBucket[0].capped, true);
  close(r.aiOnly.collections.perBucket[0].collections, 540000000);
});

test('incumbent ratio is derived per bucket through the human benchmark', () => {
  const r = runModel(DEMO_LENDER);
  const first = r.diagnostics.incumbentRatio[0];
  assert.equal(first.status, 'derived');
  close(first.incumbentVsHuman, 0.68 / 0.75);
  close(first.arrowheadVsIncumbent, 1.2 / (0.68 / 0.75));
});

test('all-AI lender with no human benchmark gets no Arrowhead number', () => {
  const inp = clone(DEMO_LENDER);
  inp.today.incumbentShare = 1;
  inp.book.buckets.forEach((b) => { b.humanCollectionRate = null; });
  const r = runModel(inp);
  assert.equal(r.motionLabel, 'all-ai');
  assert.ok(r.today.collections > 0);
  assert.equal(r.aiOnly.collections.total, null);
  assert.equal(r.aiOnly.summary.pnlImpact, null);
  assert.equal(r.diagnostics.breakEvenLift.status, 'unavailable');
  assert.ok(r.diagnostics.incumbentRatio.every((x) => x.status === 'no-benchmark'));
  assert.equal(r.vendorSlice.status, 'no-benchmark');
});

test('break-even lift makes AI-only P&L impact zero, cap included', () => {
  const inp = clone(DEMO_LENDER);
  inp.arrowhead.ratePerMinute = 60;
  const be = runModel(inp).diagnostics.breakEvenLift;
  assert.equal(be.status, 'found');
  inp.arrowhead.collectionLift = be.lift;
  const r = runModel(inp);
  close(r.aiOnly.summary.pnlImpact, 0, 1e-4);
});

test('break-even reports never when full collection cannot pay back', () => {
  const inp = clone(DEMO_LENDER);
  inp.arrowhead.ratePerMinute = 5000;
  assert.equal(runModel(inp).diagnostics.breakEvenLift.status, 'never');
});

test('P&L impact is credit cost avoided minus cost change', () => {
  const r = runModel(DEMO_LENDER);
  // added per bucket: 1-30 96.12M, 31-60 28.0M, 61-90 8.64M
  const avoided = 96120000 * 0.05 + 28000000 * 0.15 + 8640000 * 0.35;
  close(r.aiOnly.summary.creditCostAvoided, avoided);
  close(r.aiOnly.summary.pnlImpact, avoided - (r.aiOnly.cost.total - r.today.cost.total));
});

test('surge coverage reflects seat capacity inside the 11-hour window', () => {
  const r = runModel(DEMO_LENDER);
  const cap = 60 * 11 * 0.65 * 25;
  close(r.today.coverage.capacityPerDay, cap);
  close(r.today.coverage.surgeCoverage, cap / ((656000 * 0.6 * 0.5) / 8));
});

test('hang-up leak is a diagnostic and scales with recoverable share', () => {
  const a = runModel(DEMO_LENDER);
  const inp = clone(DEMO_LENDER);
  inp.arrowhead.recoverableShare = 0.6;
  const b = runModel(inp);
  close(b.diagnostics.hangups.incumbent.valueAtRisk, 2 * a.diagnostics.hangups.incumbent.valueAtRisk);
  close(a.aiOnly.collections.total, b.aiOnly.collections.total);
});

test('validation rejects impossible rates', () => {
  const inp = clone(DEMO_LENDER);
  inp.today.humanConnectRate = 1.4;
  assert.throws(() => validateInputs(inp), RangeError);
});

test('vendor slice compares the vendor with Arrowhead on the same accounts', () => {
  const r = runModel(DEMO_LENDER);
  const v = r.vendorSlice;
  assert.equal(v.status, 'derived');
  close(v.beforeCollections, 0.4 * (540e6 * 0.68 + 280e6 * 0.35 + 144e6 * 0.15));
  close(v.afterCollections, 0.4 * (540e6 * 0.9 + 280e6 * 0.48 + 144e6 * 0.24));
  close(v.beforeCost, 656000 * 0.4 * 0.30 * 2.5 * 5);
  close(v.afterCost, 656000 * 0.4 * 0.45 * 2.5 * 3.75);
  const avoided = 0.4 * ((486e6 - 367.2e6) * 0.05 + (134.4e6 - 98e6) * 0.15 + (34.56e6 - 21.6e6) * 0.35);
  close(v.pnlImpact, avoided - (v.afterCost - v.beforeCost));
});

test('all-AI lender with a historical human rate gets a vendor vs Arrowhead number', () => {
  const inp = clone(DEMO_LENDER);
  inp.today.incumbentShare = 1;
  inp.today.seats = 0;
  inp.book.humanBenchmarkIsHistorical = true;
  const r = runModel(inp);
  assert.equal(r.vendorSlice.status, 'derived');
  assert.equal(r.humanBenchmarkIsHistorical, true);
  close(r.vendorSlice.beforeCollections, r.today.collections);
  assert.ok(r.vendorSlice.pnlImpact > 0);
});

test('human-only lender has no vendor slice', () => {
  const inp = clone(DEMO_LENDER);
  inp.today.incumbentShare = 0;
  assert.equal(runModel(inp).vendorSlice.status, 'no-incumbent');
});
