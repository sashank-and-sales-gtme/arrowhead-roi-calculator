/**
 * Collections P&L engine.
 *
 * Compares a lender's current recovery motion with two Arrowhead motions:
 *   1. AI-only
 *   2. AI with escalation to the lender's own agents
 *
 * Rules the engine enforces:
 *   - Only the published collection-rate lift (vs human agents) creates rupees.
 *     The connection-rate lift, the surge coverage gap and the 10-second
 *     hang-up leak are diagnostics. They explain the result and never add to it.
 *   - Arrowhead's lift was measured on AI-only motions. Escalated calls are
 *     credited at the lender's own human rate, minus transfer drop-off.
 *   - The transfer leg runs on the lender's telco and is costed at the lender's rate.
 *   - The human collection rate is the benchmark Arrowhead's lift applies to. A lender
 *     with no human agents left can enter the rate from before it moved to AI;
 *     book.humanBenchmarkIsHistorical flags that so the page can say so.
 *   - Every rate is a fraction (0.2 = 20%). Money is INR per month.
 */

export const RBI_WINDOW_HOURS = 11; // 8 am to 7 pm

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

function assertNumber(name, value, { min = -Infinity, max = Infinity } = {}) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new TypeError(`${name} must be a number, got ${value}`);
  }
  if (value < min || value > max) {
    throw new RangeError(`${name} must be between ${min} and ${max}, got ${value}`);
  }
}

export function validateInputs(inp) {
  const { book, today, arrowhead } = inp;
  assertNumber('book.workingDays', book.workingDays, { min: 1, max: 31 });
  assertNumber('book.surgeDays', book.surgeDays, { min: 1, max: book.workingDays - 1 });
  assertNumber('book.surgeShare', book.surgeShare, { min: 0, max: 1 });
  if (!Array.isArray(book.buckets) || book.buckets.length === 0) {
    throw new TypeError('book.buckets must be a non-empty array');
  }
  book.buckets.forEach((b, i) => {
    assertNumber(`buckets[${i}].accounts`, b.accounts, { min: 0 });
    assertNumber(`buckets[${i}].avgOverdue`, b.avgOverdue, { min: 0 });
    assertNumber(`buckets[${i}].attemptsPerAccount`, b.attemptsPerAccount, { min: 0 });
    assertNumber(`buckets[${i}].creditCostRate`, b.creditCostRate, { min: 0, max: 1 });
    if (b.humanCollectionRate !== null) {
      assertNumber(`buckets[${i}].humanCollectionRate`, b.humanCollectionRate, { min: 0, max: 1 });
    }
    if (b.incumbentCollectionRate !== null) {
      assertNumber(`buckets[${i}].incumbentCollectionRate`, b.incumbentCollectionRate, { min: 0, max: 1 });
    }
  });
  assertNumber('today.incumbentShare', today.incumbentShare, { min: 0, max: 1 });
  [
    'seats', 'utilisation', 'dialsPerProductiveHour', 'humanConnectRate',
    'humanHangup10', 'humanHandleMinutes', 'seatCostMonthly', 'telcoRatePerMinute',
    'incumbentConnectRate', 'incumbentHangup10', 'incumbentTalkMinutes', 'incumbentRatePerMinute',
  ].forEach((k) => assertNumber(`today.${k}`, today[k], { min: 0 }));
  ['utilisation', 'humanConnectRate', 'humanHangup10', 'incumbentConnectRate', 'incumbentHangup10']
    .forEach((k) => assertNumber(`today.${k}`, today[k], { min: 0, max: 1 }));
  assertNumber('arrowhead.collectionLift', arrowhead.collectionLift, { min: -1 });
  ['connectionLift', 'ratePerMinute', 'talkMinutes'].forEach((k) =>
    assertNumber(`arrowhead.${k}`, arrowhead[k], { min: 0 }));
  ['escalationRate', 'transferDropoff', 'recoverableShare', 'seatsReleasedShare'].forEach((k) =>
    assertNumber(`arrowhead.${k}`, arrowhead[k], { min: 0, max: 1 }));
}

/** Productive calling minutes one seat delivers per day inside the RBI window. */
function productiveMinutesPerSeatDay(today) {
  return RBI_WINDOW_HOURS * 60 * today.utilisation;
}

/** Splits a monthly volume into per-day load on surge days and on normal days. */
function dailyLoad(monthly, book) {
  return {
    surge: (monthly * book.surgeShare) / book.surgeDays,
    normal: (monthly * (1 - book.surgeShare)) / (book.workingDays - book.surgeDays),
  };
}

function bucketToday(b, today) {
  const overdue = b.accounts * b.avgOverdue;
  let humanPart = 0;
  if (today.incumbentShare < 1) {
    humanPart = b.humanCollectionRate === null ? null : overdue * (1 - today.incumbentShare) * b.humanCollectionRate;
  }
  let aiPart = 0;
  if (today.incumbentShare > 0) {
    aiPart = b.incumbentCollectionRate === null ? null : overdue * today.incumbentShare * b.incumbentCollectionRate;
  }
  const collections = humanPart === null || aiPart === null ? null : humanPart + aiPart;
  return { overdue, collections };
}

function computeToday(inp) {
  const { book, today } = inp;
  const attempts = sum(book.buckets.map((b) => b.accounts * b.attemptsPerAccount));
  const humanAttempts = attempts * (1 - today.incumbentShare);
  const incumbentAttempts = attempts * today.incumbentShare;

  const humanConnects = humanAttempts * today.humanConnectRate;
  const incumbentConnects = incumbentAttempts * today.incumbentConnectRate;

  const buckets = book.buckets.map((b) => bucketToday(b, today));
  const collectionsKnown = buckets.every((x) => x.collections !== null);
  const collections = collectionsKnown ? sum(buckets.map((x) => x.collections)) : null;

  const cost = {
    seats: today.seats * today.seatCostMonthly,
    telco: humanConnects * today.humanHandleMinutes * today.telcoRatePerMinute,
    incumbentAI: incumbentConnects * today.incumbentTalkMinutes * today.incumbentRatePerMinute,
  };
  cost.total = cost.seats + cost.telco + cost.incumbentAI;

  // Human capacity inside the RBI window, and how much of the workload it covers.
  const seatAttemptsPerDay = today.seats * RBI_WINDOW_HOURS * today.utilisation * today.dialsPerProductiveHour;
  const load = dailyLoad(humanAttempts, book);
  const coverage = {
    capacityPerDay: seatAttemptsPerDay,
    requiredSurgeDay: load.surge,
    requiredNormalDay: load.normal,
    surgeCoverage: load.surge === 0 ? 1 : clamp01(seatAttemptsPerDay / load.surge),
    normalCoverage: load.normal === 0 ? 1 : clamp01(seatAttemptsPerDay / load.normal),
  };
  coverage.surgeAttemptsUnworked = Math.max(0, load.surge - seatAttemptsPerDay) * book.surgeDays;

  return {
    attempts, humanAttempts, incumbentAttempts, humanConnects, incumbentConnects,
    buckets, collections, cost, coverage,
  };
}

/**
 * Hang-ups within 10 seconds of connecting, and the rupees they put at risk.
 * Value at risk = hang-ups x recoverable share x rupees collected per sustained conversation.
 * Diagnostic only: never added to any motion's collections.
 */
function computeHangupLeak(inp, t) {
  const { today, arrowhead, book } = inp;
  const channel = (connects, hangupRate, share, rateKey) => {
    const hangups = connects * hangupRate;
    const sustained = connects - hangups;
    const channelCollections = sum(book.buckets.map((b) => {
      const r = b[rateKey];
      return r === null ? 0 : b.accounts * b.avgOverdue * share * r;
    }));
    const perSustained = sustained > 0 ? channelCollections / sustained : 0;
    return {
      connects, hangups, hangupRate,
      rupeesPerSustainedConversation: perSustained,
      valueAtRisk: hangups * arrowhead.recoverableShare * perSustained,
    };
  };
  return {
    human: channel(t.humanConnects, today.humanHangup10, 1 - today.incumbentShare, 'humanCollectionRate'),
    incumbent: channel(t.incumbentConnects, today.incumbentHangup10, today.incumbentShare, 'incumbentCollectionRate'),
  };
}

/** Arrowhead vs the lender's incumbent AI, derived through the shared human benchmark, per bucket. */
function computeIncumbentRatio(inp) {
  const lift = 1 + inp.arrowhead.collectionLift;
  return inp.book.buckets.map((b) => {
    if (inp.today.incumbentShare === 0) return { label: b.label, status: 'no-incumbent' };
    if (b.humanCollectionRate === null || b.incumbentCollectionRate === null || b.humanCollectionRate === 0) {
      return { label: b.label, status: 'no-benchmark' };
    }
    const incumbentVsHuman = b.incumbentCollectionRate / b.humanCollectionRate;
    return {
      label: b.label,
      status: 'derived',
      incumbentVsHuman,
      arrowheadVsIncumbent: incumbentVsHuman === 0 ? null : lift / incumbentVsHuman,
    };
  });
}

function arrowheadCollections(inp, multiplierFor) {
  const { book } = inp;
  const perBucket = book.buckets.map((b) => {
    if (b.humanCollectionRate === null) return { label: b.label, collections: null, capped: false };
    const raw = b.humanCollectionRate * multiplierFor(b);
    const capped = raw > 1;
    return { label: b.label, collections: b.accounts * b.avgOverdue * Math.min(1, raw), capped };
  });
  const known = perBucket.every((x) => x.collections !== null);
  return { perBucket, total: known ? sum(perBucket.map((x) => x.collections)) : null };
}

/** Seats the lender keeps after moving calling to Arrowhead. */
function retainedSeatCount(inp) {
  return Math.round(inp.today.seats * (1 - inp.arrowhead.seatsReleasedShare));
}

/**
 * Like-for-like view on the accounts the lender's AI vendor works today.
 * Before: the vendor's own collection rate and cost on those accounts.
 * After: Arrowhead on the same accounts, at the human benchmark x (1 + lift).
 * Human agents and seats are untouched, so they drop out of this view.
 */
function computeVendorSlice(inp, t, aiOnly) {
  const { book, today, arrowhead } = inp;
  const share = today.incumbentShare;
  if (share === 0) return { status: 'no-incumbent' };

  const lift = 1 + arrowhead.collectionLift;
  const perBucket = book.buckets.map((b) => {
    const overdue = b.accounts * b.avgOverdue * share;
    const before = b.incumbentCollectionRate === null ? null : overdue * b.incumbentCollectionRate;
    const after = b.humanCollectionRate === null ? null : overdue * Math.min(1, b.humanCollectionRate * lift);
    return { label: b.label, overdue, before, after, creditCostRate: b.creditCostRate };
  });
  const beforeCost = t.cost.incumbentAI;
  const afterMinutes = t.incumbentAttempts * aiOnly.connectRate * arrowhead.talkMinutes;
  const afterCost = afterMinutes * arrowhead.ratePerMinute;

  if (perBucket.some((x) => x.before === null)) {
    return { status: 'no-vendor-rate', perBucket, beforeCost, afterCost };
  }
  const beforeCollections = sum(perBucket.map((x) => x.before));
  if (perBucket.some((x) => x.after === null)) {
    return { status: 'no-benchmark', perBucket, beforeCollections, beforeCost, afterCost };
  }
  const afterCollections = sum(perBucket.map((x) => x.after));
  const creditCostAvoided = sum(perBucket.map((x) => (x.after - x.before) * x.creditCostRate));
  return {
    status: 'derived',
    perBucket,
    beforeCollections,
    afterCollections,
    addedCollections: afterCollections - beforeCollections,
    beforeCost,
    afterCost,
    costChange: afterCost - beforeCost,
    creditCostAvoided,
    pnlImpact: creditCostAvoided - (afterCost - beforeCost),
    vendorHangups: t.incumbentConnects * today.incumbentHangup10,
  };
}

function computeAIOnly(inp, t) {
  const { arrowhead, today } = inp;
  const lift = 1 + arrowhead.collectionLift;
  const connectRate = clamp01(today.humanConnectRate * (1 + arrowhead.connectionLift));
  const connects = t.attempts * connectRate;
  const minutes = connects * arrowhead.talkMinutes;
  const retainedSeats = retainedSeatCount(inp);
  const cost = {
    arrowhead: minutes * arrowhead.ratePerMinute,
    retainedSeats: retainedSeats * today.seatCostMonthly,
  };
  cost.total = cost.arrowhead + cost.retainedSeats;
  return {
    retainedSeats,
    connectRate,
    connectRateCapped: today.humanConnectRate * (1 + arrowhead.connectionLift) > 1,
    connects, minutes, cost,
    collections: arrowheadCollections(inp, () => lift),
  };
}

function computeAIEscalation(inp, t, aiOnly) {
  const { arrowhead, today, book } = inp;
  const lift = 1 + arrowhead.collectionLift;
  const e = arrowhead.escalationRate;
  const d = arrowhead.transferDropoff;

  // Calls closed by the AI keep the AI-only lift. Escalated calls collect at
  // the lender's human rate, and borrowers lost in the transfer collect nothing.
  const multiplier = (1 - e) * lift + e * (1 - d);

  const escalated = aiOnly.connects * e;
  const handled = escalated * (1 - d);
  const humanMinutes = handled * today.humanHandleMinutes;

  // Staff the escalation queue for surge days, since escalations arrive with the AI's volume.
  const load = dailyLoad(handled, book);
  const minutesPerSeatDay = productiveMinutesPerSeatDay(today);
  const queueSeatsSurge = minutesPerSeatDay > 0 ? Math.ceil((load.surge * today.humanHandleMinutes) / minutesPerSeatDay) : 0;
  const queueSeatsNormal = minutesPerSeatDay > 0 ? Math.ceil((load.normal * today.humanHandleMinutes) / minutesPerSeatDay) : 0;

  // Escalations queue on the seats the lender keeps. Extra seats are hired only
  // when the surge-day queue needs more than that.
  const retainedSeats = retainedSeatCount(inp);
  const extraQueueSeats = Math.max(0, queueSeatsSurge - retainedSeats);
  const cost = {
    arrowhead: aiOnly.minutes * arrowhead.ratePerMinute,
    transferLeg: humanMinutes * today.telcoRatePerMinute,
    retainedSeats: retainedSeats * today.seatCostMonthly,
    extraQueueSeats: extraQueueSeats * today.seatCostMonthly,
  };
  cost.total = cost.arrowhead + cost.transferLeg + cost.retainedSeats + cost.extraQueueSeats;

  return {
    multiplier, escalated, handled, droppedInTransfer: escalated - handled,
    humanMinutes, queueSeatsSurge, queueSeatsNormal, retainedSeats, extraQueueSeats, cost,
    collections: arrowheadCollections(inp, () => multiplier),
  };
}

/**
 * Cash view: added collections this month.
 * P&L view: credit cost avoided (added collections x each bucket's credit-cost rate)
 * minus the change in collection cost. A collected EMI is cash, not profit; the
 * P&L effect is the share of it that would otherwise have become provisions or write-offs.
 */
function summarise(motionCollections, cost, t, inp) {
  const { total, perBucket } = motionCollections;
  if (total === null || t.collections === null) {
    return { collections: total, cost: cost.total, collectedPerRupee: null, addedCollections: null, creditCostAvoided: null, pnlImpact: null };
  }
  const creditCostAvoided = sum(perBucket.map((x, i) =>
    (x.collections - t.buckets[i].collections) * inp.book.buckets[i].creditCostRate));
  const costChange = cost.total - t.cost.total;
  return {
    collections: total,
    cost: cost.total,
    collectedPerRupee: cost.total > 0 ? total / cost.total : null,
    addedCollections: total - t.collections,
    costChange,
    creditCostAvoided,
    pnlImpact: creditCostAvoided - costChange,
  };
}

/**
 * Collection lift at which the AI-only motion's P&L impact is zero, respecting the
 * 100% cap per bucket. P&L impact rises with the lift, so a bisection finds the root.
 * Returns { lift, status }: 'found', 'never' (even full collection doesn't pay back),
 * or 'unavailable' (human benchmark or today's collections missing).
 */
function breakEvenLift(inp, t, aiOnly) {
  const buckets = inp.book.buckets;
  if (t.collections === null || buckets.some((b) => b.humanCollectionRate === null)) {
    return { lift: null, status: 'unavailable' };
  }
  const costChange = aiOnly.cost.total - t.cost.total;
  const pnlAt = (lift) => sum(buckets.map((b, i) => {
    const collected = b.accounts * b.avgOverdue * Math.min(1, b.humanCollectionRate * (1 + lift));
    return (collected - t.buckets[i].collections) * b.creditCostRate;
  })) - costChange;

  let lo = -1;
  const positiveRates = buckets.map((b) => b.humanCollectionRate).filter((h) => h > 0);
  let hi = positiveRates.length ? Math.max(...positiveRates.map((h) => 1 / h)) - 1 : 0;
  if (pnlAt(hi) < 0) return { lift: null, status: 'never' };
  if (pnlAt(lo) >= 0) return { lift: lo, status: 'found' };
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (pnlAt(mid) >= 0) hi = mid; else lo = mid;
  }
  return { lift: hi, status: 'found' };
}

export function runModel(inp) {
  validateInputs(inp);
  const t = computeToday(inp);
  const aiOnly = computeAIOnly(inp, t);
  const aiEsc = computeAIEscalation(inp, t, aiOnly);
  const motionLabel = inp.today.incumbentShare === 0
    ? 'human-only'
    : inp.today.incumbentShare === 1 ? 'all-ai' : 'mixed';

  return {
    motionLabel,
    today: {
      ...t,
      summary: {
        collections: t.collections,
        cost: t.cost.total,
        collectedPerRupee: t.collections !== null && t.cost.total > 0 ? t.collections / t.cost.total : null,
      },
    },
    vendorSlice: computeVendorSlice(inp, t, aiOnly),
    humanBenchmarkIsHistorical: Boolean(inp.book.humanBenchmarkIsHistorical),
    aiOnly: { ...aiOnly, summary: summarise(aiOnly.collections, aiOnly.cost, t, inp) },
    aiEscalation: { ...aiEsc, summary: summarise(aiEsc.collections, aiEsc.cost, t, inp) },
    diagnostics: {
      hangups: computeHangupLeak(inp, t),
      incumbentRatio: computeIncumbentRatio(inp),
      connectionLift: {
        humanConnects: t.humanConnects + t.incumbentConnects,
        arrowheadConnects: aiOnly.connects,
      },
      breakEvenLift: breakEvenLift(inp, t, aiOnly),
    },
  };
}
