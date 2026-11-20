/**
 * Arrowhead's published collections results, as shown on Arrowhead's website
 * (collections case panel: Banking / lending; EMI collections, promise-to-pay,
 * callbacks). Measured on AI-only motions against human agents.
 * Read as relative lifts: 0.20 means a collection rate 1.2x the human rate.
 */
export const ARROWHEAD_BENCHMARKS = {
  collectionLift: {
    value: 0.20,
    label: 'Higher collection rate than human agents on any given bucket',
    source: 'Arrowhead website, collections case panel',
  },
  connectionLift: {
    value: 0.50,
    label: 'Higher connection rate than human agents',
    source: 'Arrowhead website, collections case panel',
  },
  writeOffROI: {
    value: 4,
    label: 'ROI on every rupee spent on the bot, for write-off accounts',
    source: 'Arrowhead website, collections case panel',
    note: 'Not used: write-off accounts are outside this model.',
  },
};

/** Arrowhead pricing per connected minute, all-in including telephony. */
export const ARROWHEAD_RATE_RANGE = { min: 3.5, max: 4.0, default: 3.75 };
