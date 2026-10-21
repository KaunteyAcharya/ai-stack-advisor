// Combines costs, TCO, break-even, value and scoring into one recommendation object.
// Explanations are built from fixed templates (no AI-generated text).

import { OPTION_IDS, OPTION_LABELS } from "./inputs.js";
import { monthlyCosts, volume, hybridMonthly, oneTimeCost, shareSelfOf } from "./costs.js";
import { taxProfile } from "./tax.js";
import { projectTco, pvFactor } from "./tco.js";
import { apiVsSelfhost, costCurve } from "./breakeven.js";
import { valueForInputs, classifyProfile, formatPp } from "./value.js";
import { isAgent, isInternal, valuedOnTime } from "./agents.js";
import { scoreOptions, weightedScore, CRITERIA } from "./scoring.js";

export const DEFAULT_COST_WEIGHT = 50;
export const HIGH_TICKET_COST_WEIGHT = 25;
export const ROBUSTNESS_STEP = 10; // percentage points each weight is moved up and down
export const DEFLECTION_SENSITIVITY = [20, 40, 60, 80];
export const HYBRID_SHARES = [10, 20, 30, 40, 50, 60, 70, 80, 90];

const usd = (x) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(x);
const num = (x) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(x);

/**
 * Hybrid split with the lowest 36-month cost (option D only), searched over 10%–90% self-hosted.
 * Returns { bestPct, rows: [{ pct, tco36 }] }.
 */
export function cheapestHybridSplit(inputs, prices, months = 36) {
  const rows = HYBRID_SHARES.map((pct) => {
    let total = oneTimeCost(inputs, "D");
    for (let m = 0; m < months; m++) total += monthlyCosts({ ...inputs, shareSelfPct: pct }, prices, m).D.total;
    return { pct, tco36: total };
  });
  const best = rows.reduce((a, b) => (b.tco36 < a.tco36 ? b : a));
  return { bestPct: best.pct, rows };
}

/** Final score per option = costWeight × cost score + (1 − costWeight) × weighted non-cost score. */
export function finalScores({ costScores, scores, weights, costWeight, excluded }) {
  return Object.fromEntries(
    OPTION_IDS.map((id) => [id, excluded[id] ? -1 : costWeight * costScores[id] + (1 - costWeight) * weightedScore(scores, weights, id)]),
  );
}

const winner = (fs) => OPTION_IDS.filter((id) => fs[id] >= 0).sort((a, b) => fs[b] - fs[a])[0] ?? null;

/**
 * Does the recommendation change if any single weight (each criterion, and the cost weight)
 * moves ±10 percentage points? Returns { robust, flips: [{ factor, label, direction, winner }] }.
 */
export function robustnessCheck({ costScores, scores, weights, costWeight, excluded }) {
  const base = winner(finalScores({ costScores, scores, weights, costWeight, excluded }));
  const flips = [];
  const factors = [...CRITERIA.map((c) => ({ id: c.id, label: c.label })), { id: "cost", label: "Cost weight" }];
  for (const f of factors) {
    for (const dir of [-1, 1]) {
      let w = weights;
      let cw = costWeight;
      if (f.id === "cost") cw = Math.min(1, Math.max(0, costWeight + (dir * ROBUSTNESS_STEP) / 100));
      else w = { ...weights, [f.id]: Math.max(0, (weights[f.id] ?? 0) + dir * ROBUSTNESS_STEP) };
      const win = winner(finalScores({ costScores, scores, weights: w, costWeight: cw, excluded }));
      if (win !== base) flips.push({ factor: f.id, label: f.label, direction: dir > 0 ? "up" : "down", winner: win });
    }
  }
  return { robust: flips.length === 0, flips };
}

/**
 * Inputs as seen by an option that runs on open models: self-hosted completes `openModelGapPct`
 * points fewer tasks; the hybrid only on its self-hosted share. Agents lose completion rate,
 * internal tools lose minutes saved, chat loses deflection (support savings).
 */
export function qualityAdjusted(inputs, option, shareSelf) {
  const gap = (inputs.openModelGapPct ?? 0) * (option === "C" ? 1 : option === "D" ? shareSelf : 0);
  if (gap <= 0) return inputs;
  const clamp = (x) => Math.max(0, Math.min(100, x));
  return {
    ...inputs,
    successPct: clamp(inputs.successPct - gap),
    deflectionPct: clamp(inputs.deflectionPct - gap),
    minutesSavedPerRequest: inputs.minutesSavedPerRequest * (1 - gap / 100),
  };
}

/** Monthly benefit that depends on answer quality: time saved (agents, internal tools) or support savings (chat). */
const qualityBenefit = (v) => (v ? (v.kind === "agent" ? v.benefit : v.supportSavings) ?? 0 : 0);

/**
 * @param inputs  full inputs object (see engine/inputs.js)
 * @param prices  output of indexPrices()
 * @param opts    { formatMoney(usd) → string, formatNumber(n) → string, months, curve: boolean,
 *                  light: boolean (skip report-only extras, for simulations), hybridPct: fixed hybrid split }
 */
export function analyze(inputs, prices, opts = {}) {
  const money = opts.formatMoney || usd;
  const number = opts.formatNumber || num;
  const months = opts.months ?? 36;

  const scoring = scoreOptions(inputs);
  // Hybrid split: all self-hosted if data may not leave; else the user's choice, or the cheapest.
  let hybrid = { mode: "manual", pct: inputs.shareSelfPct, rows: null };
  if (scoring.excluded.B) hybrid = { mode: "data_must_stay", pct: 100, rows: null };
  else if (inputs.shareSelfPct == null && opts.hybridPct != null) hybrid = { mode: "auto", pct: opts.hybridPct, rows: null };
  else if (inputs.shareSelfPct == null) {
    const best = cheapestHybridSplit(inputs, prices, months);
    hybrid = { mode: "auto", pct: best.bestPct, rows: best.rows };
  }
  const shareSelf = hybrid.pct / 100;

  const month1 = monthlyCosts(inputs, prices, 0, 1, { shareSelf });
  if (month1.A.unavailable && !scoring.excluded.A) scoring.excluded.A = month1.A.unavailable;

  const tco = projectTco(inputs, prices, { months, shareSelf });
  const light = !!opts.light;
  const tcoNoGrowth = light ? tco : projectTco({ ...inputs, growthPct: 0 }, prices, { months, shareSelf });
  const tax = taxProfile(inputs, prices.taxes);
  const breakeven = light ? null : apiVsSelfhost(inputs, prices);
  const curve = opts.curve === false ? null : costCurve(inputs, prices, { shareSelf });
  const vol = volume(inputs, 0);
  const agent = isAgent(inputs);
  const internal = isInternal(inputs);
  const timeValued = valuedOnTime(inputs);
  // Agents and internal tools are valued on time saved, not ticket size, so they get their own profile.
  const profile = timeValued ? "automation" : classifyProfile(inputs.ticketUsd, vol.conversationsPerMonth);
  const costWeight = (inputs.costWeightPct ?? (profile === "high_ticket" ? HIGH_TICKET_COST_WEIGHT : DEFAULT_COST_WEIGHT)) / 100;

  const viable = OPTION_IDS.filter((id) => !scoring.excluded[id]);
  const valueFor = (monthly, oneTime, deflectionPct = inputs.deflectionPct, inp = inputs) => valueForInputs(inp, vol, monthly, oneTime, { agent, internal, deflectionPct: inp === inputs ? deflectionPct : inp.deflectionPct });

  // Value of each option, with open models completing fewer tasks (quality-adjusted).
  const values = Object.fromEntries(
    OPTION_IDS.map((id) => [id, Number.isFinite(month1[id].total) ? valueFor(month1[id].total, tco[id].oneTime, undefined, qualityAdjusted(inputs, id, shareSelf)) : null]),
  );
  // Decision cost = present value of 36-month cost + present value of the quality-dependent benefit
  // an option gives up compared with the best option (growing with volume).
  const bestBenefit = Math.max(0, ...viable.map((id) => qualityBenefit(values[id])));
  const growth = Array.from({ length: months }, (_, m) => (vol.requestsPerMonth > 0 ? volume(inputs, m).requestsPerMonth / vol.requestsPerMonth : 1));
  const lostPv = (id) => {
    const lost = Math.max(0, bestBenefit - qualityBenefit(values[id]));
    return growth.reduce((s, g, m) => s + lost * g * pvFactor(m, inputs.discountRatePct ?? 0), 0);
  };
  const decision = Object.fromEntries(OPTION_IDS.map((id) => [id, tco[id].pv36 + (values[id] ? lostPv(id) : 0)]));
  const minDecision = Math.min(...viable.map((id) => decision[id]));
  const costScores = Object.fromEntries(OPTION_IDS.map((id) => [id, scoring.excluded[id] ? 0 : minDecision / decision[id]]));
  const scoreArgs = { costScores, scores: scoring.scores, weights: inputs.weights, costWeight, excluded: scoring.excluded };
  const fs = finalScores(scoreArgs);

  const options = OPTION_IDS.map((id) => ({
    id,
    label: OPTION_LABELS[id],
    monthly: month1[id].total,
    lines: month1[id].lines,
    flags: month1[id].flags || [],
    pricingType: month1[id].pricingType,
    gpus: month1[id].gpus,
    oneTime: tco[id].oneTime,
    tco12: tco[id].tco12,
    tco36: tco[id].tco36,
    tco36NoGrowth: tcoNoGrowth[id].tco36,
    pv36: tco[id].pv36,
    valueLostPv: decision[id] - tco[id].pv36,
    decisionCost: decision[id],
    taxMonthly: month1[id].taxMonthly || 0,
    costScore: costScores[id],
    nonCostScore: weightedScore(scoring.scores, inputs.weights, id),
    finalScore: Math.max(0, fs[id]),
    excluded: scoring.excluded[id] || null,
    notes: scoring.notes[id],
    warnings: scoring.warnings[id],
    value: values[id],
  }));

  const ranked = options.filter((o) => !o.excluded).sort((a, b) => b.finalScore - a.finalScore);
  const best = ranked[0];
  for (const o of options) o.status = o.excluded ? "excluded" : o === best ? "recommended" : "viable";

  const robustness = best && !light ? robustnessCheck(scoreArgs) : { robust: true, flips: [] };
  robustness.margin = ranked.length > 1 ? ranked[0].finalScore - ranked[1].finalScore : null;
  robustness.runnerUp = ranked[1]?.id ?? null;

  // Deflection rate drives both support savings and per-resolution SaaS pricing (not used for agents).
  const deflectionSensitivity = timeValued || light ? [] : DEFLECTION_SENSITIVITY.map((d) => {
    const alt = { ...inputs, deflectionPct: d };
    const costs = monthlyCosts(alt, prices, 0, 1, { shareSelf });
    const row = { deflectionPct: d, saasMonthly: Number.isFinite(costs.A.total) ? costs.A.total : null };
    if (best) {
      const v = valueFor(costs[best.id].total, best.oneTime, d);
      row.recommendedMonthly = costs[best.id].total;
      row.supportSavings = v.supportSavings;
      row.roiAtZeroUplift = v.roiAt(0);
    }
    return row;
  });

  const monthlyRange = best && !light
    ? {
        low: monthlyCosts(inputs, prices, 0, 0.5, { shareSelf })[best.id].total,
        expected: best.monthly,
        high: monthlyCosts(inputs, prices, 0, 2, { shareSelf })[best.id].total,
      }
    : null;

  const priceIds = new Set();
  for (const id of OPTION_IDS) month1[id].priceIds.forEach((p) => priceIds.add(p));
  const pricesUsed = [...priceIds].map((id) => prices.byId[id]).filter(Boolean);

  const warnings = [];
  for (const o of options) for (const w of o.warnings) warnings.push({ option: o.id, message: w });
  for (const o of options) for (const f of o.flags) warnings.push({ option: o.id, message: `${o.label}: ${f}` });

  const explanation = light
    ? []
    : best
    ? explain({ inputs, best, options, breakeven, profile, vol, money, number, robustness, hybrid, tax })
    : ["No option is viable with the current constraints."];

  return {
    valueKind: timeValued ? "agent" : "conversation",
    profile,
    costWeight,
    volume: vol,
    options,
    ranked: ranked.map((o) => o.id),
    recommended: best?.id ?? null,
    excluded: options.filter((o) => o.excluded).map((o) => ({ id: o.id, reason: o.excluded })),
    monthlyRange,
    tco,
    tcoNoGrowth,
    hybrid,
    tax,
    breakeven,
    curve,
    scoring,
    robustness,
    deflectionSensitivity,
    warnings,
    explanation,
    pricesUsed,
    hasSamplePrices: pricesUsed.some((p) => p.is_sample),
  };
}

/** Plain-language sentences built from templates. */
export function explain({ inputs, best, options, breakeven, profile, vol, money, number = num, robustness, hybrid, tax }) {
  const out = [];
  const by = Object.fromEntries(options.map((o) => [o.id, o]));
  const reqs = number(vol.requestsPerMonth);

  if (best.id === "B" && !by.C.excluded) {
    const be = breakeven.breakevenRequestsPerMonth;
    out.push(
      `${best.label} is recommended because at ${reqs} requests/month it costs about ${money(best.monthly)}/month, ` +
        `below the ~${money(breakeven.fixedSelfhostMonthly)}/month fixed cost of self-hosting; ` +
        `self-hosting only becomes cheaper above ~${number(be)} requests/month.`,
    );
  } else if (best.id === "C" || best.id === "D") {
    const why = by.B.excluded ? "data must stay on infrastructure the company controls" : `at ${reqs} requests/month the fixed GPU cost is spread over enough traffic`;
    out.push(`${best.label} is recommended because ${why}. It costs about ${money(best.monthly)}/month and ${money(best.tco36)} over 36 months.`);
  } else {
    out.push(`${best.label} is recommended: it costs about ${money(best.monthly)}/month (${money(best.tco36)} over 36 months) and scores best once time to launch, team fit and risk are weighed.`);
  }

  const v = best.value;
  if (v?.internal) {
    const hours = number(Math.round(v.netHours));
    const fte = v.fte.toFixed(v.fte < 10 ? 2 : 1);
    const saved = inputs.valueUnit === "fte" ? `about ${fte} FTE (${hours} hours a month)` : `about ${hours} hours a month (${fte} FTE)`;
    out.push(`At ${inputs.minutesSavedPerRequest} minutes saved per request, it saves ${saved} of staff time, worth ${money(v.benefit)} a month, against ${money(best.monthly)} of AI cost.`);
    out.push(`It pays for itself if each request saves at least ${v.breakevenMinutesPerRequest < 1 ? "a few seconds" : `${Math.ceil(v.breakevenMinutesPerRequest * 10) / 10} minutes`} of work.`);
  } else if (v?.kind === "agent") {
    const hours = number(Math.round(v.netHours));
    const fte = v.fte.toFixed(v.fte < 10 ? 2 : 1);
    const saved = inputs.valueUnit === "fte" ? `about ${fte} FTE (${hours} hours a month)` : `about ${hours} hours a month (${fte} FTE)`;
    out.push(`After review time, the agent saves ${saved} of manual work, worth ${money(v.benefit)} a month net of error costs, against ${money(best.monthly)} of AI cost.`);
    if (v.net > 0) {
      out.push(`It pays for itself as long as it completes at least ${Math.min(100, Math.ceil(v.breakevenSuccessPct))}% of tasks without a person (assumed: ${inputs.successPct}%).`);
    } else {
      const reach = v.breakevenSuccessPct <= 100 ? `it needs to complete at least ${Math.ceil(v.breakevenSuccessPct)}% of tasks without a person (assumed: ${inputs.successPct}%)` : "even at 100% completion it would not cover its cost at this volume";
      out.push(`At these assumptions it does not pay for itself: ${reach}.`);
    }
    if (inputs.useBatch && best.id !== "A") out.push("Batch API prices are used because this work can run asynchronously.");
  } else if (v && Number.isFinite(v.breakevenExtraSales)) {
    const salesText =
      v.breakevenExtraSales >= 1
        ? `${number(v.salesNeeded)} extra sales per month`
        : `about one extra sale every ${number(Math.ceil(1 / v.breakevenExtraSales))} months`;
    out.push(`Counting only the profit on a first sale, it pays for itself with ${salesText} (a ${formatPp(v.breakevenConversionUpliftPp)} percentage-point lift in conversion).`);
    if (v.hasLtvLine && Number.isFinite(v.ltvBreakevenCustomers)) {
      out.push(`Counting repeat purchases, ~${number(v.ltvCustomersNeeded)} new customers/month would cover it, with that value realised over 12 months.`);
    }
  }

  if (profile === "high_ticket") {
    out.push("With a high ticket size, AI cost is small next to the value of one sale, so the decision should favour answer quality, response speed and a smooth human handoff for serious leads over saving on monthly cost.");
  } else if (profile === "low_ticket_high_volume") {
    out.push("With low ticket sizes and high volume, cost per conversation matters most; keep AI cost well below the value each conversation brings.");
  }

  // Quality gap: value an open-model option gives up, counted as a cost.
  const gapped = options.filter((o) => !o.excluded && o.valueLostPv > 1 && (o.id === "C" || o.id === "D"));
  if (gapped.length && (inputs?.openModelGapPct ?? 0) > 0) {
    const worst = gapped.reduce((a, b) => (b.valueLostPv > a.valueLostPv ? b : a));
    out.push(`Open models are assumed to complete ${inputs.openModelGapPct} percentage points fewer tasks. For ${worst.label.toLowerCase()} that gives up about ${money(worst.valueLostPv)} of value over 36 months (present value), which is added to its cost in the comparison.`);
  }

  if (inputs && inputs.growthPct > 0 && best.tco36NoGrowth < best.tco36) {
    const months = inputs.growthMonths ?? 36;
    out.push(
      `Growth of ${inputs.growthPct}% a month${months < 36 ? ` for ${number(months)} months` : ""} raises the 36-month cost from ${money(best.tco36NoGrowth)} (no growth) to ${money(best.tco36)}.`,
    );
  }

  if (best.id === "D" && hybrid?.mode === "auto") {
    out.push(`The hybrid is cheapest with ${hybrid.pct}% of requests self-hosted and the rest via API.`);
  }

  if (tax && tax.nonRecoverablePct > 0) {
    out.push(`Costs include ${tax.nonRecoverablePct}% ${tax.name} on vendor spend that cannot be reclaimed (${tax.label}).`);
  } else if (tax && tax.totalPct > 0) {
    out.push(`Prices exclude ${tax.label}; it is reclaimable for a registered business, so it is not added to costs.`);
  }

  if (robustness.robust) {
    out.push("Robust: the recommendation stays the same when any single weight moves 10 points up or down.");
  } else {
    const f = robustness.flips[0];
    const runner = by[f.winner]?.label ?? f.winner;
    out.push(`Close call, decided by ${f.label.toLowerCase()}: moving that weight ${f.direction} 10 points makes ${runner} the top option.`);
  }

  for (const o of options) if (o.excluded) out.push(`${o.label} is excluded: ${o.excluded.toLowerCase()}.`);
  if (by.C.status !== "recommended" && by.C.warnings.length && !by.C.excluded) out.push(`Self-hosting is not recommended for this team: ${by.C.warnings[0]}`);
  return out;
}
