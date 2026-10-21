// Simulation and sensitivity ("how sure is this?").
//
// Monte Carlo: each run draws every uncertain quantity from a triangular distribution
// (low, typical, high) and re-runs the analysis. Engine assumptions (prices, GPU throughput,
// labour, the open-model quality gap) always vary; the user's own inputs vary only when marked
// "not sure". Runs are seeded, so the same inputs always give the same result.
//
// Tornado: each factor alone is moved to its low and high end; factors are sorted by how much
// they move the result.

import { analyze } from "./recommend.js";
import { RANGE_SPECS } from "./ranges.js";
import { isAgent, isInternal, valuedOnTime } from "./agents.js";

/** Which input factors make sense for a use case. */
const INPUT_APPLIES = {
  usersPerDay: (i) => !isAgent(i),
  tasksPerMonth: (i) => isAgent(i),
  growthPct: () => true,
  successPct: (i) => isAgent(i),
  humanMinutesPerTask: (i) => isAgent(i),
  minutesSavedPerRequest: (i) => isInternal(i),
  conversionPct: (i) => !valuedOnTime(i),
  deflectionPct: (i) => !valuedOnTime(i),
  humanSharePct: (i) => !valuedOnTime(i),
};

/** Engine assumptions: multipliers (or absolute points for the quality gap) with low / high ends. */
export const ENGINE_FACTORS = [
  { id: "llmPrice", label: "LLM API prices", low: 0.8, high: 1.25 },
  { id: "gpuPrice", label: "GPU rental prices", low: 0.75, high: 1.3 },
  { id: "gpuThroughput", label: "GPU throughput (assumption)", low: 0.7, high: 1.3 },
  { id: "engineerHourly", label: "Engineer hourly cost", low: 0.75, high: 1.3 },
  { id: "maintenanceHours", label: "Build and maintenance hours", low: 0.7, high: 1.5 },
  { id: "staffHourly", label: "Staff hourly cost", low: 0.75, high: 1.3, applies: (i) => valuedOnTime(i) },
  { id: "openModelGap", label: "Open-model quality gap", absolute: true, low: 0, high: 20 },
];

/** Factors for these inputs: every applicable engine factor, plus input factors (all, or only `onlyKeys`). */
export function factorsFor(inputs, { onlyKeys = null } = {}) {
  const inputFactors = Object.keys(RANGE_SPECS)
    .filter((k) => INPUT_APPLIES[k](inputs) && Number.isFinite(inputs[k]) && (!onlyKeys || onlyKeys.includes(k)))
    .map((k) => {
      const typical = inputs[k];
      return { id: k, label: RANGE_SPECS[k].label, kind: "input", low: RANGE_SPECS[k].low(typical), mode: typical, high: RANGE_SPECS[k].high(typical) };
    });
  const engine = ENGINE_FACTORS.filter((f) => !f.applies || f.applies(inputs)).map((f) =>
    f.absolute
      ? { ...f, kind: "engine", mode: inputs.openModelGapPct ?? 0, high: Math.max(f.high, inputs.openModelGapPct ?? 0) }
      : { ...f, kind: "engine", mode: 1 },
  );
  return [...inputFactors, ...engine];
}

/** Prices with LLM, GPU and throughput figures scaled (cloned; the original is untouched). */
function scalePrices(prices, { llm = 1, gpu = 1, thr = 1 }) {
  if (llm === 1 && gpu === 1 && thr === 1) return prices;
  const scaleLlm = (e) =>
    e && {
      ...e,
      input_price: e.input_price * llm,
      output_price: e.output_price * llm,
      ...(e.batch_input_price != null ? { batch_input_price: e.batch_input_price * llm, batch_output_price: e.batch_output_price * llm } : {}),
      ...(e.cached_input_price != null ? { cached_input_price: e.cached_input_price * llm } : {}),
    };
  const mapObj = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
  return {
    ...prices,
    llm: mapObj(prices.llm, scaleLlm),
    gpu: mapObj(prices.gpu, (g) => ({ ...g, price: g.price * gpu })),
    throughput: mapObj(prices.throughput, (t) => ({ ...t, value: t.value * thr })),
  };
}

/** Inputs and prices with the given factor values applied. */
export function applyFactors(inputs, prices, values) {
  const i = { ...inputs, maintenanceHours: { ...inputs.maintenanceHours }, buildHours: { ...inputs.buildHours } };
  const scale = {};
  for (const [id, x] of Object.entries(values)) {
    if (id in RANGE_SPECS) i[id] = x;
    else if (id === "llmPrice") scale.llm = x;
    else if (id === "gpuPrice") scale.gpu = x;
    else if (id === "gpuThroughput") scale.thr = x;
    else if (id === "engineerHourly") i.engineerHourlyUsd = inputs.engineerHourlyUsd * x;
    else if (id === "staffHourly") i.staffHourlyUsd = inputs.staffHourlyUsd * x;
    else if (id === "openModelGap") i.openModelGapPct = x;
    else if (id === "maintenanceHours") {
      for (const o of Object.keys(i.maintenanceHours)) i.maintenanceHours[o] = inputs.maintenanceHours[o] * x;
      for (const o of Object.keys(i.buildHours)) i.buildHours[o] = inputs.buildHours[o] * x;
    }
  }
  return { inputs: i, prices: scalePrices(prices, scale) };
}

/** Seeded random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw from a triangular distribution with minimum a, mode c, maximum b. */
export function triangular(u, a, c, b) {
  if (b <= a) return a;
  const f = (c - a) / (b - a);
  return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c));
}

/** The result each run records: the recommendation, its monthly cost and its net monthly benefit. */
export function outcome(r) {
  const best = r.options.find((o) => o.id === r.recommended);
  if (!best) return null;
  const v = best.value;
  // Net monthly benefit: time saved (agents, internal tools) or support savings with no sales uplift, minus AI cost.
  const benefit = v ? (v.kind === "agent" ? v.benefit : v.supportSavings ?? 0) : 0;
  return { recommended: best.id, monthly: best.monthly, pv36: best.pv36, net: benefit - best.monthly };
}

/** One simulation run (deterministic for a given seed and index). */
export function simulateRun(inputs, prices, factors, index, { seed = 1, hybridPct } = {}) {
  const u = rng(seed * 100_003 + index);
  const values = Object.fromEntries(factors.map((f) => [f.id, triangular(u(), f.low, f.mode, f.high)]));
  const applied = applyFactors(inputs, prices, values);
  return outcome(analyze(applied.inputs, applied.prices, { curve: false, light: true, hybridPct }));
}

/** Percentile (0–1) of a sorted array, with linear interpolation. */
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Summary of many runs: how often each option wins, and 10th/50th/90th percentiles. */
export function summarize(samples) {
  const ok = samples.filter(Boolean);
  const wins = {};
  for (const s of ok) wins[s.recommended] = (wins[s.recommended] || 0) + 1;
  const pct = (key) => {
    const sorted = ok.map((s) => s[key]).filter(Number.isFinite).sort((a, b) => a - b);
    return { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) };
  };
  return {
    runs: ok.length,
    winShare: Object.fromEntries(Object.entries(wins).map(([k, n]) => [k, n / ok.length])),
    monthly: pct("monthly"),
    pv36: pct("pv36"),
    net: pct("net"),
    probNetPositive: ok.length ? ok.filter((s) => s.net > 0).length / ok.length : null,
  };
}

/** Full simulation in one go (tests, export). The app runs simulateRun in small chunks instead. */
export function simulate(inputs, prices, { runs = 300, seed = 1, hybridPct } = {}) {
  const factors = factorsFor(inputs, { onlyKeys: inputs.uncertainKeys || [] });
  const samples = [];
  for (let k = 0; k < runs; k++) samples.push(simulateRun(inputs, prices, factors, k, { seed, hybridPct }));
  return { factors, ...summarize(samples) };
}

/**
 * Tornado: every applicable factor alone at its low and high end. Metric: net monthly benefit of the
 * option recommended at that end (and whether the recommendation changes).
 */
export function tornado(inputs, prices, { hybridPct } = {}) {
  const base = outcome(analyze(inputs, prices, { curve: false, light: true, hybridPct }));
  if (!base) return null;
  const rows = factorsFor(inputs).map((f) => {
    const at = (x) => {
      const a = applyFactors(inputs, prices, { [f.id]: x });
      return outcome(analyze(a.inputs, a.prices, { curve: false, light: true, hybridPct }));
    };
    const low = at(f.low);
    const high = at(f.high);
    return {
      id: f.id,
      label: f.label,
      kind: f.kind,
      absolute: !!f.absolute,
      lowValue: f.low,
      highValue: f.high,
      lowNet: low?.net ?? null,
      highNet: high?.net ?? null,
      lowRecommended: low?.recommended ?? null,
      highRecommended: high?.recommended ?? null,
      flips: (low && low.recommended !== base.recommended) || (high && high.recommended !== base.recommended),
      swing: Math.abs((high?.net ?? 0) - (low?.net ?? 0)),
    };
  });
  rows.sort((a, b) => b.swing - a.swing);
  return { base, rows };
}
