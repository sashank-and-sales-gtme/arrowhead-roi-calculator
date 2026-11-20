import { runModel, RBI_WINDOW_HOURS } from '/engine/model.js';
import { DEMO_LENDER } from '/data/demo-lender.js';
import { ARROWHEAD_BENCHMARKS, ARROWHEAD_RATE_RANGE } from '/data/benchmarks.js';

const form = document.getElementById('inputs');
const errorBox = document.getElementById('form-error');
let state = structuredClone(DEMO_LENDER);
let lastResult = null;

/* ---------- formatting ---------- */

const inrFull = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const pct = (x, digits = 0) => `${(x * 100).toFixed(digits)}%`;

function inr(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return 'Not available';
  const sign = x < 0 ? '−' : '';
  const a = Math.abs(x);
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(1)} L`;
  return `${sign}₹${inrFull.format(a)}`;
}

function signedInr(x) {
  if (x === null || x === undefined) return 'Not available';
  return x > 0 ? `+${inr(x)}` : inr(x);
}

const count = (x) => inrFull.format(Math.round(x));

/* ---------- state <-> form ---------- */

const getPath = (obj, path) => path.split('.').reduce((o, k) => o[k], obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

const BUCKET_FIELDS = [
  { key: 'accounts', label: 'Accounts', step: 100 },
  { key: 'avgOverdue', label: 'Average overdue (₹)', step: 100 },
  { key: 'attemptsPerAccount', label: 'Call attempts per account', step: 1 },
  { key: 'humanCollectionRate', label: 'Collection rate, human agents (%), today or before AI', pct: true, nullable: true },
  { key: 'incumbentCollectionRate', label: 'Collection rate, AI vendor (%)', pct: true, nullable: true },
  { key: 'creditCostRate', label: 'Uncollected rupees that become credit cost (%)', pct: true },
];

function renderBucketTable() {
  const host = document.getElementById('bucket-table');
  const head = state.book.buckets.map((b) => `<th scope="col">${b.label}</th>`).join('');
  const rows = BUCKET_FIELDS.map((f) => {
    const cells = state.book.buckets.map((b, i) => {
      const name = `book.buckets.${i}.${f.key}`;
      const attrs = f.pct ? 'data-pct min="0" max="100" step="0.1"' : `min="0" step="${f.step}"`;
      const nullable = f.nullable ? 'data-nullable' : '';
      return `<td data-label="${b.label}"><input type="number" name="${name}" ${attrs} ${nullable} aria-label="${f.label}, ${b.label}"></td>`;
    }).join('');
    return `<tr><th scope="row">${f.label}</th>${cells}</tr>`;
  }).join('');
  host.innerHTML = `<table><thead><tr><th scope="col"><span class="visually-hidden">Measure</span></th>${head}</tr></thead><tbody>${rows}</tbody></table>
    <p class="hint">Collection rate is the share of the bucket's overdue amount collected this month. If AI makes all your calls, use the human rate from before you switched. Leave a rate blank if you have no data for it.</p>`;
}

function writeForm() {
  form.querySelectorAll('input[name]').forEach((el) => {
    const v = getPath(state, el.name);
    if (el.type === 'checkbox') { el.checked = Boolean(v); return; }
    if (v === null || v === undefined) { el.value = ''; return; }
    el.value = el.hasAttribute('data-pct') ? +(v * 100).toFixed(4) : v;
  });
  toggleSections();
}

function readField(el) {
  if (el.type === 'checkbox') return el.checked;
  if (el.value.trim() === '') return el.hasAttribute('data-nullable') ? null : NaN;
  const n = Number(el.value);
  return el.hasAttribute('data-pct') ? n / 100 : n;
}

function toggleSections() {
  const share = state.today.incumbentShare;
  document.getElementById('incumbent-fields').hidden = !(share > 0);
  document.getElementById('human-fields').classList.toggle('muted', share === 1);
}

/* ---------- rendering ---------- */

function renderWindow(r) {
  const host = document.getElementById('window');
  const cov = r.today.coverage;
  const humanAttempts = r.today.humanAttempts;
  const readout = document.getElementById('hero-readout');

  if (humanAttempts === 0 || cov.capacityPerDay === 0) {
    host.innerHTML = '';
    readout.textContent = humanAttempts === 0
      ? 'All your calls run on AI today, so seats don’t limit the window. The question becomes how many connected calls your AI loses in the first 10 seconds.'
      : 'Add your calling seats to see how much of the window they cover.';
    return;
  }

  const ratio = cov.requiredSurgeDay / cov.capacityPerDay;
  // The window keeps a fixed length; demand is drawn to the same scale and may run past 7 pm.
  const shown = Math.min(Math.max(ratio, 1), 4);
  const frameWidth = 100 / Math.max(shown, 1.25);
  const demandPct = Math.min(ratio, 4) * 100;
  const hours = Array.from({ length: RBI_WINDOW_HOURS + 1 }, (_, i) => 8 + i);
  const ticks = hours.filter((h) => h % 2 === 0).map((h) => {
    const i = h - 8;
    const label = h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`;
    return `<span class="tick" style="left:${(i / RBI_WINDOW_HOURS) * 100}%">${label}</span>`;
  }).join('');

  host.innerHTML = `
    <div class="window-track">
      <div class="window-frame" style="width:${frameWidth}%">
        <div class="demand ${ratio > 1 ? 'over' : ''}" style="width:${demandPct}%; --fit:${(100 / Math.min(ratio, 4)).toFixed(2)}%"></div>
        <div class="close-line"><span>7 pm, calls stop</span></div>
      </div>
      <div class="ticks" style="width:${frameWidth}%">${ticks}</div>
    </div>
    <div class="window-legend">
      <span class="key key-fit">Calls your seats can make in the window</span>
      <span class="key key-over">Calls due that the window can't fit</span>
    </div>`;

  readout.innerHTML = ratio > 1
    ? `On each of your ${state.book.surgeDays} surge days, your agents need <strong>${count(cov.requiredSurgeDay)}</strong> attempts and can make <strong>${count(cov.capacityPerDay)}</strong>. That leaves <strong class="loss">${count(cov.surgeAttemptsUnworked)}</strong> attempts unworked across the surge. Arrowhead runs calls in parallel, so the window stops being the limit.`
    : `Your agents can make ${count(cov.capacityPerDay)} attempts a day and your surge days need ${count(cov.requiredSurgeDay)}. The window fits your load, so the case rests on collection rate and cost.`;
}

function renderPnl(r) {
  const tbody = document.querySelector('#pnl tbody');
  const t = r.today.summary;
  const a = r.aiOnly.summary;
  const e = r.aiEscalation.summary;
  const row = (label, cells, cls = '') =>
    `<tr class="${cls}"><th scope="row">${label}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const capNote = r.aiOnly.collections.perBucket.some((x) => x.capped)
    ? ' <span class="flag">capped at 100% in at least one bucket</span>' : '';

  tbody.innerHTML = [
    row('Collected this month', [inr(t.collections), inr(a.collections) + capNote, inr(e.collections)]),
    row('Added collections vs today', ['', signedInr(a.addedCollections), signedInr(e.addedCollections)]),
    row('Collection cost', [inr(t.cost), inr(a.cost), inr(e.cost)]),
    row('Credit cost avoided', ['', signedInr(a.creditCostAvoided), signedInr(e.creditCostAvoided)]),
    row('P&amp;L impact per month', ['', signedInr(a.pnlImpact), signedInr(e.pnlImpact)], 'total'),
  ].join('');
  labelCells(document.getElementById('pnl'));

  const headline = document.getElementById('pnl-headline');
  if (a.pnlImpact === null) {
    headline.textContent = 'Without a human collection rate to measure against, there is no published figure to apply. A pilot on your own accounts is the honest way to get this number.';
  } else {
    headline.innerHTML = `With Arrowhead running calls on its own, your monthly P&amp;L moves by <strong class="${a.pnlImpact < 0 ? 'loss' : ''}">${signedInr(a.pnlImpact)}</strong>. With escalation to your agents, by <strong class="${e.pnlImpact < 0 ? 'loss' : ''}">${signedInr(e.pnlImpact)}</strong>.`;
  }
}

/** Copies each column header onto its cells, so narrow screens can stack rows with labels. */
function labelCells(table) {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((cell, i) => {
      if (cell.tagName === 'TD') {
        cell.dataset.label = heads[i] || '';
        if (!cell.textContent.trim()) cell.classList.add('empty');
      }
    });
  });
}

function renderVendor(r) {
  const v = r.vendorSlice;
  const tbody = document.querySelector('#vendor tbody');
  const headline = document.getElementById('vendor-headline');
  const lede = document.getElementById('vendor-lede');
  const table = document.getElementById('vendor');
  document.getElementById('historical-caveat').hidden = !(r.humanBenchmarkIsHistorical && v.status === 'derived');

  if (v.status === 'no-incumbent') {
    table.hidden = true;
    lede.textContent = 'You don’t use a voice AI vendor today, so the comparison below is against your human agents.';
    headline.textContent = '';
    return;
  }
  table.hidden = false;
  lede.textContent = `On the ${pct(state.today.incumbentShare)} of accounts your vendor works today, this month.`;
  const row = (label, cells, cls = '') =>
    `<tr class="${cls}"><th scope="row">${label}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;

  if (v.status !== 'derived') {
    tbody.innerHTML = row('Collection cost', [inr(v.beforeCost), inr(v.afterCost), signedInr(v.afterCost - v.beforeCost)]);
    labelCells(table);
    headline.textContent = v.status === 'no-vendor-rate'
      ? 'Add your vendor’s collection rate in each bucket to see what it collects against Arrowhead.'
      : 'Add your human collection rate in each bucket, from today or from before you moved to AI, to see what Arrowhead would collect on these accounts.';
    return;
  }
  const capped = v.perBucket.some((x) => x.after === x.overdue);
  tbody.innerHTML = [
    row('Collected this month', [inr(v.beforeCollections), inr(v.afterCollections) + (capped ? ' <span class="flag">capped at 100% in at least one bucket</span>' : ''), signedInr(v.addedCollections)]),
    row('Collection cost', [inr(v.beforeCost), inr(v.afterCost), signedInr(v.costChange)]),
    row('Credit cost avoided', ['', '', signedInr(v.creditCostAvoided)]),
    row('P&amp;L impact per month', ['', '', signedInr(v.pnlImpact)], 'total'),
  ].join('');
  const hang = v.vendorHangups > 0
    ? ` Your vendor also loses ${count(v.vendorHangups)} connected calls a month in the first 10 seconds.` : '';
  labelCells(table);
  headline.innerHTML = `Moving these accounts from your vendor to Arrowhead collects <strong>${inr(v.addedCollections)}</strong> more and moves your monthly P&amp;L by <strong class="${v.pnlImpact < 0 ? 'loss' : ''}">${signedInr(v.pnlImpact)}</strong>.${hang}`;
}

function renderDiagnostics(r) {
  const d = r.diagnostics;
  const items = [];
  const h = d.hangups;

  if (r.today.humanConnects > 0) {
    items.push(['Human calls ended within 10 seconds', `${count(h.human.hangups)} a month, putting ${inr(h.human.valueAtRisk)} at risk`]);
  }
  if (r.today.incumbentConnects > 0) {
    items.push(['AI vendor calls ended within 10 seconds', `${count(h.incumbent.hangups)} a month, putting ${inr(h.incumbent.valueAtRisk)} at risk`]);
  }
  items.push(['Connected calls a month', `${count(d.connectionLift.humanConnects)} today, ${count(d.connectionLift.arrowheadConnects)} with Arrowhead${r.aiOnly.connectRateCapped ? ' (capped at 100% connect rate)' : ''}`]);

  const be = d.breakEvenLift;
  let beText = 'Not available without a human collection rate in every bucket.';
  if (be.status === 'found') {
    beText = be.lift <= 0
      ? `Arrowhead pays for itself even at ${pct(Math.abs(be.lift), 1)} below your human collection rate. The published result is ${pct(state.arrowhead.collectionLift)} above it.`
      : `Arrowhead needs a collection rate ${pct(be.lift, 1)} above your human agents to break even. The published result is ${pct(state.arrowhead.collectionLift)}.`;
  } else if (be.status === 'never') {
    beText = 'At these prices, no collection rate pays back the cost.';
  }
  items.push(['Break-even point', beText]);

  const esc = r.aiEscalation;
  items.push(['Escalations reaching your agents', `${count(esc.handled)} a month, ${count(esc.droppedInTransfer)} lost in transfer. Surge days need ${esc.queueSeatsSurge} seats on the queue; you keep ${esc.retainedSeats}.`]);

  document.getElementById('diagnostics').innerHTML = items
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

function renderRatio(r) {
  const tbody = document.querySelector('#ratio tbody');
  tbody.innerHTML = r.diagnostics.incumbentRatio.map((x) => {
    let text;
    if (x.status === 'no-incumbent') text = 'You don’t use a voice AI vendor today.';
    else if (x.status === 'no-benchmark') text = 'No human collection rate in this bucket to compare against.';
    else text = `Your vendor collects at ${x.incumbentVsHuman.toFixed(2)}× your agents. Arrowhead’s published result implies ${x.arrowheadVsIncumbent.toFixed(2)}× your vendor.`;
    return `<tr><th scope="row">${x.label}</th><td>${text}</td></tr>`;
  }).join('');
}

function labelFor(el) {
  if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
  const label = el.closest('label');
  if (!label) return el.name;
  const copy = label.cloneNode(true);
  copy.querySelectorAll('input, .hint, .tag').forEach((n) => n.remove());
  return copy.textContent.trim();
}

function firstInvalidField() {
  return [...form.querySelectorAll('input[name]')].find((el) => {
    if (el.closest('[hidden]') || el.type === 'checkbox') return false;
    const v = readField(el);
    if (v === null) return false;
    if (Number.isNaN(v)) return true;
    const min = el.min === '' ? -Infinity : Number(el.min);
    const max = el.max === '' ? Infinity : Number(el.max);
    const shown = Number(el.value);
    return shown < min || shown > max;
  });
}

const INCUMBENT_KEYS = ['incumbentConnectRate', 'incumbentHangup10', 'incumbentTalkMinutes', 'incumbentRatePerMinute'];

/** Fields in a hidden section don't apply, so blanks there are treated as zero. */
function modelInput() {
  const inp = structuredClone(state);
  if (inp.today.incumbentShare === 0) {
    INCUMBENT_KEYS.forEach((k) => { if (inp.today[k] === null || Number.isNaN(inp.today[k])) inp.today[k] = 0; });
  }
  return inp;
}

function render() {
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  const bad = firstInvalidField();
  if (bad) {
    lastResult = null;
    bad.setAttribute('aria-invalid', 'true');
    errorBox.hidden = false;
    errorBox.textContent = bad.value.trim() === ''
      ? `Fill in “${labelFor(bad)}” to see your results.`
      : `“${labelFor(bad)}” must be between ${bad.min || 'any'} and ${bad.max || 'any'}.`;
    return;
  }
  try {
    lastResult = runModel(modelInput());
    errorBox.hidden = true;
    renderWindow(lastResult);
    renderVendor(lastResult);
    renderPnl(lastResult);
    renderDiagnostics(lastResult);
    renderRatio(lastResult);
  } catch (err) {
    lastResult = null;
    errorBox.hidden = false;
    errorBox.textContent = `These inputs don't fit together: ${err.message}`;
  }
}

/* ---------- events ---------- */

form.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.name) return;
  setPath(state, el.name, readField(el));
  document.getElementById('demo-note').textContent = 'Using your values. Fields you haven’t changed still hold the fictional example.';
  if (el.name === 'today.incumbentShare') toggleSections();
  render();
});

document.getElementById('reset-demo').addEventListener('click', () => {
  state = structuredClone(DEMO_LENDER);
  document.getElementById('demo-note').textContent = 'Showing a fictional lender, Kaveri Finance. Replace any value with your own.';
  writeForm();
  render();
});

document.getElementById('clear-all').addEventListener('click', () => {
  const blank = structuredClone(DEMO_LENDER);
  blank.book.buckets.forEach((b) => Object.keys(b).forEach((k) => { if (k !== 'label') b[k] = null; }));
  Object.keys(blank.today).forEach((k) => { blank.today[k] = null; });
  blank.today.incumbentShare = 0;
  blank.arrowhead = {
    ...blank.arrowhead,
    collectionLift: ARROWHEAD_BENCHMARKS.collectionLift.value,
    connectionLift: ARROWHEAD_BENCHMARKS.connectionLift.value,
    ratePerMinute: ARROWHEAD_RATE_RANGE.default,
  };
  state = blank;
  document.getElementById('demo-note').textContent = 'Enter your numbers. Arrowhead’s published figures are filled in for you.';
  writeForm();
  render();
});

document.getElementById('lead-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const status = document.getElementById('lead-status');
  const data = Object.fromEntries(new FormData(ev.target));
  if (!lastResult) {
    status.textContent = 'Complete the calculator above first, so the breakdown has numbers to send.';
    return;
  }
  const payload = {
    contact: { email: data.email, company: data.company },
    buyerType: data.buyerType,
    currentMotion: lastResult.motionLabel,
    headline: {
      collectionsToday: lastResult.today.summary.collections,
      addedCollectionsVsVendor: lastResult.vendorSlice.addedCollections ?? null,
      pnlImpactVsVendor: lastResult.vendorSlice.pnlImpact ?? null,
      humanBenchmarkIsHistorical: lastResult.humanBenchmarkIsHistorical,
      pnlImpactAIOnly: lastResult.aiOnly.summary.pnlImpact,
      pnlImpactEscalation: lastResult.aiEscalation.summary.pnlImpact,
      surgeAttemptsUnworked: lastResult.today.coverage.surgeAttemptsUnworked,
      incumbentHangups10s: lastResult.diagnostics.hangups.incumbent.hangups,
    },
    inputs: state,
    submittedAt: new Date().toISOString(),
  };
  status.textContent = 'Sending…';
  try {
    const res = await fetch('/api/lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    status.textContent = 'Sent. Arrowhead’s team will email you this breakdown with your numbers.';
    ev.target.reset();
  } catch (err) {
    status.textContent = `Couldn't send: ${err.message}. Check your connection and try again.`;
  }
});

renderBucketTable();
writeForm();
render();
