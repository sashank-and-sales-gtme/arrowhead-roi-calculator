import { ARROWHEAD_BENCHMARKS, ARROWHEAD_RATE_RANGE } from './benchmarks.js';

/**
 * Kaveri Finance is a fictional South Indian NBFC.
 * Every number below except Arrowhead's published lifts and price is illustrative,
 * chosen to demonstrate the mechanics. Replace them with a real lender's data.
 */
export const DEMO_LENDER = {
  name: 'Kaveri Finance (fictional)',
  book: {
    workingDays: 26,
    surgeDays: 8,
    surgeShare: 0.5,
    humanBenchmarkIsHistorical: false,
    buckets: [
      { label: '1–30 DPD', accounts: 60000, avgOverdue: 9000, attemptsPerAccount: 6, humanCollectionRate: 0.75, incumbentCollectionRate: 0.68, creditCostRate: 0.05 },
      { label: '31–60 DPD', accounts: 20000, avgOverdue: 14000, attemptsPerAccount: 10, humanCollectionRate: 0.40, incumbentCollectionRate: 0.35, creditCostRate: 0.15 },
      { label: '61–90 DPD', accounts: 8000, avgOverdue: 18000, attemptsPerAccount: 12, humanCollectionRate: 0.20, incumbentCollectionRate: 0.15, creditCostRate: 0.35 },
    ],
  },
  today: {
    incumbentShare: 0.4,
    seats: 60,
    utilisation: 0.65,
    dialsPerProductiveHour: 25,
    humanConnectRate: 0.30,
    humanHangup10: 0.08,
    humanHandleMinutes: 3.5,
    seatCostMonthly: 32000,
    telcoRatePerMinute: 0.6,
    incumbentConnectRate: 0.30,
    incumbentHangup10: 0.22,
    incumbentTalkMinutes: 2.5,
    incumbentRatePerMinute: 5,
  },
  arrowhead: {
    collectionLift: ARROWHEAD_BENCHMARKS.collectionLift.value,
    connectionLift: ARROWHEAD_BENCHMARKS.connectionLift.value,
    ratePerMinute: ARROWHEAD_RATE_RANGE.applied,
    talkMinutes: 2.5,
    escalationRate: 0.10,
    transferDropoff: 0.25,
    recoverableShare: 0.30,
    seatsReleasedShare: 0,
  },
};
