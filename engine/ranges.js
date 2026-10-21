// "Not sure?" ranges. Inputs a user marks as uncertain are moved to the low and high end of a
// plausible band, the analysis runs again, and the report shows the spread of the results.
// Two cases are run: every uncertain input at its low end, and every one at its high end.

import { analyze } from "./recommend.js";
import { analyzePortfolio, describeCombo } from "./portfolio.js";
import { OPTION_LABELS } from "./inputs.js";

const clampPct = (x) => Math.max(0, Math.min(100, x));

/** Plausible bands around the typical value the user entered. */
export const RANGE_SPECS = {
  usersPerDay: { label: "Users per day", low: (v) => v * 0.6, high: (v) => v * 1.5 },
  tasksPerMonth: { label: "Tasks per month", low: (v) => v * 0.6, high: (v) => v * 1.5 },
  growthPct: { label: "Monthly growth", low: () => 0, high: (v) => Math.max(v * 2, 5) },
  successPct: { label: "Tasks done without a person", low: (v) => clampPct(v - 20), high: (v) => clampPct(v + 10) },
  humanMinutesPerTask: { label: "Minutes per task today", low: (v) => v * 0.7, high: (v) => v * 1.3 },
  minutesSavedPerRequest: { label: "Minutes saved per request", low: (v) => v * 0.5, high: (v) => v * 1.5 },
  conversionPct: { label: "Conversion rate", low: (v) => v * 0.7, high: (v) => clampPct(v * 1.3) },
  deflectionPct: { label: "Share the AI handles", low: (v) => clampPct(v - 20), high: (v) => clampPct(v + 15) },
  humanSharePct: { label: "Conversations reaching a person", low: (v) => clampPct(v * 0.5), high: (v) => clampPct(v * 1.5) },
};

export const RANGE_KEYS = Object.keys(RANGE_SPECS);

/** Text for a hint: "Range used: 1,000–2,500". */
export function rangeBounds(key, value) {
  const s = RANGE_SPECS[key];
  return s && Number.isFinite(value) ? { low: s.low(value), high: s.high(value) } : null;
}

/** Inputs with every uncertain field moved to its `end` ("low" | "high"), in every workload. */
export function applyRange(inputs, end) {
  const keys = (inputs.uncertainKeys || []).filter((k) => RANGE_SPECS[k]);
  const shift = (obj) => {
    const out = { ...obj };
    for (const k of keys) if (Number.isFinite(out[k])) out[k] = RANGE_SPECS[k][end](out[k]);
    return out;
  };
  return { ...shift(inputs), extraWorkloads: (inputs.extraWorkloads || []).map(shift) };
}

/** Headline numbers of one analysis (single workload). */
function headline(r) {
  const best = r.options.find((o) => o.id === r.recommended);
  if (!best) return null;
  const v = best.value || {};
  return {
    recommended: best.id,
    recommendedLabel: OPTION_LABELS[best.id],
    monthly: best.monthly,
    tco36: best.tco36,
    netHours: v.kind === "agent" ? v.netHours : null,
    fte: v.kind === "agent" ? v.fte : null,
    net: v.kind === "agent" ? v.net : null,
    paybackMonths: v.kind === "agent" ? v.paybackMonths : v.paybackAt?.(0) ?? null,
    salesNeeded: Number.isFinite(v.salesNeeded) ? v.salesNeeded : null,
    supportSavings: Number.isFinite(v.supportSavings) ? v.supportSavings : null,
  };
}

/** Headline numbers of a portfolio analysis. */
function portfolioHeadline(p) {
  const r = p.recommended;
  if (!r) return null;
  const agents = p.detail.perWorkload.filter((w) => w.agent);
  return {
    recommended: r.combo.join(""),
    recommendedLabel: describeCombo(r, p.names),
    monthly: r.monthly1,
    tco36: r.tco36,
    netHours: agents.length ? agents.reduce((s, w) => s + w.value.netHours, 0) : null,
    fte: agents.length ? agents.reduce((s, w) => s + w.value.fte, 0) : null,
    net: null,
    paybackMonths: null,
    salesNeeded: null,
    supportSavings: null,
  };
}

/**
 * Runs the low and high cases. Returns null when nothing is marked uncertain.
 * @returns { keys, cases: { low, typical, high }, span(metric) → [min, max] | null, recommendationChanges }
 */
export function analyzeRange(inputs, prices, { usecases, portfolio = (inputs.extraWorkloads || []).length > 0 } = {}) {
  const keys = (inputs.uncertainKeys || []).filter((k) => RANGE_SPECS[k]);
  if (!keys.length) return null;
  const run = (inp) =>
    portfolio ? portfolioHeadline(analyzePortfolio(inp, prices, { usecases })) : headline(analyze(inp, prices, { curve: false }));
  const cases = { low: run(applyRange(inputs, "low")), typical: run(inputs), high: run(applyRange(inputs, "high")) };
  const all = Object.values(cases).filter(Boolean);
  const span = (metric) => {
    const values = all.map((c) => c[metric]).filter((x) => x != null && Number.isFinite(x));
    return values.length ? [Math.min(...values), Math.max(...values)] : null;
  };
  const labels = [...new Set(all.map((c) => c.recommendedLabel))];
  return { keys, cases, span, recommendationChanges: labels.length > 1, labels, portfolio };
}
