// Several workloads at once: one stack for everything, or the best option per workload?
//
// Up to EXHAUSTIVE_LIMIT workloads, every assignment of options to workloads is evaluated (4^n).
// Beyond that (4^11 ≈ 4 million), a local search starts from each single stack and from each
// workload's own best option, then moves one workload at a time while the score improves.
// Workloads on the same stack share its fixed costs:
//   - shared infrastructure (databases, hosting, vector DB, storage, monitoring) is paid once;
//   - self-hosted GPUs are sized for the pooled peak load of all workloads on them, using the
//     largest model any of them needs;
//   - build and maintenance effort is the stack's base hours plus `extraWorkloadEffortPct`
//     of the base for each extra workload.
// Each distinct stack pays its own base effort, which is the real cost of mixing.

import { OPTION_IDS, OPTION_LABELS, workloadsOf } from "./inputs.js";
import { volume, saasMonthly, apiMonthly, selfhostMonthly, hybridMonthly, gpuPlan, HOURS_PER_MONTH, sum, DEFAULT_SHARE_SELF, oneTimeHours } from "./costs.js";
import { pvFactor } from "./tco.js";
import { gpusNeeded } from "./capacity.js";
import { taxProfile, applyTax } from "./tax.js";
import { scoreOptions, weightedScore } from "./scoring.js";
import { valueForInputs } from "./value.js";
import { isAgent, isInternal } from "./agents.js";

export const SHORT_LABELS = { A: "SaaS", B: "API", C: "Self-hosted", D: "Hybrid" };
export const EXHAUSTIVE_LIMIT = 5;

const COST_FN = {
  A: (w, p, m) => saasMonthly(w, p, m),
  B: (w, p, m) => apiMonthly(w, p, m),
  C: (w, p, m) => selfhostMonthly(w, p, m),
  D: (w, p, m, share) => hybridMonthly(w, p, m, 1, share),
};

export function workloadLabel(w, usecasesData) {
  return w.workloadName || usecasesData?.usecases?.[w.useCase]?.label || w.useCase;
}

/** Effort multiplier for n workloads on one stack. */
export const effortFactor = (n, extraPct) => 1 + Math.max(0, n - 1) * (extraPct / 100);

/** Self-hosted GPUs for several workloads together: pooled peak tokens/sec, largest model needed. */
export function pooledGpu(ws, prices, m, share) {
  let biggest = null;
  let tokPerSec = 0;
  let ha = false;
  for (const w of ws) {
    const v = volume(w, m);
    const plan = gpuPlan(w, prices, v, share);
    if (!biggest || plan.gpu.vram_gb > biggest.gpu.vram_gb) biggest = plan;
    tokPerSec += v.peakRequestsPerSec * share * v.avgOutTokens * plan.overhead;
    ha = ha || w.uptime === "high_availability";
  }
  const gpus = gpusNeeded({ peakRequestsPerSec: 1, outTokens: tokPerSec, gpuTokensPerSec: biggest.thr.value, highAvailability: ha, headroom: prices.selfhost.headroom });
  return {
    gpus,
    gpuClass: biggest.gpuClass,
    line: { label: `GPU rental, shared (${gpus} × ${biggest.gpu.label})`, usd: gpus * biggest.gpu.price * HOURS_PER_MONTH, gpu: true, basis: [{ qty: gpus * HOURS_PER_MONTH, unit: "GPU-hours", rate: biggest.gpu.price }] },
    priceIds: [biggest.gpu.id, biggest.thr.id],
  };
}

/**
 * Monthly cost of one stack serving the workloads `idx` (indexes into `ws`), month m.
 * `raw[option][i][m]` caches the single-workload results.
 */
function stackMonthly(option, idx, ws, prices, m, share, raw, names) {
  const variable = [];
  const shared = new Map();
  const priceIds = new Set();
  for (const i of idx) {
    const r = raw(option, i, m);
    r.priceIds.forEach((p) => priceIds.add(p));
    for (const l of r.lines) {
      if (l.labour || l.gpu) continue;
      if (l.shared) {
        if (!shared.has(l.label) || shared.get(l.label).usd < l.usd) shared.set(l.label, l);
        continue;
      }
      variable.push({ ...l, label: idx.length > 1 || ws.length > 1 ? `${names[i]}: ${l.label}` : l.label, workload: i });
    }
  }
  const lines = [...variable, ...shared.values()];
  let gpus = 0;
  if (option === "C" || option === "D") {
    const g = pooledGpu(idx.map((i) => ws[i]), prices, m, option === "D" ? share : 1);
    lines.push(g.line);
    g.priceIds.forEach((p) => priceIds.add(p));
    gpus = g.gpus;
  }
  const base = ws[0];
  const hours = base.maintenanceHours[option] * effortFactor(idx.length, base.extraWorkloadEffortPct);
  lines.push({
    label: option === "C" || option === "D" ? "Operations labour" : "Maintenance labour",
    usd: hours * base.engineerHourlyUsd,
    labour: true,
    basis: [{ qty: hours, unit: "hours", rate: base.engineerHourlyUsd }],
  });
  const taxed = applyTax({ total: sum(lines), lines }, taxProfile(base, prices.taxes));
  return { ...taxed, gpus, priceIds: [...priceIds] };
}

/** All assignments of options to n workloads, e.g. ["B","B"], ["A","B"], … */
function* assignments(n) {
  const total = OPTION_IDS.length ** n;
  for (let k = 0; k < total; k++) {
    const combo = [];
    let x = k;
    for (let i = 0; i < n; i++) {
      combo.push(OPTION_IDS[x % OPTION_IDS.length]);
      x = Math.floor(x / OPTION_IDS.length);
    }
    yield combo;
  }
}

/**
 * Evaluates every combination for the workloads in `inputs`.
 * @param opts { months, usecases (for names), costWeight }
 */
export function analyzePortfolio(inputs, prices, opts = {}) {
  const months = opts.months ?? 36;
  const ws = workloadsOf(inputs);
  const names = ws.map((w, i) => workloadLabel(w, opts.usecases) + (ws.filter((x) => workloadLabel(x, opts.usecases) === workloadLabel(w, opts.usecases)).length > 1 ? ` (${i + 1})` : ""));
  const scoring = ws.map((w) => scoreOptions(w));
  const dataMustStay = scoring[0].excluded.B != null;
  const share = dataMustStay ? 1 : inputs.shareSelfPct == null ? DEFAULT_SHARE_SELF : inputs.shareSelfPct / 100;

  const cache = new Map();
  const raw = (option, i, m) => {
    const key = `${option}|${i}|${m}`;
    if (!cache.has(key)) cache.set(key, COST_FN[option](ws[i], prices, m, share));
    return cache.get(key);
  };

  // Which options each workload may use.
  const allowed = ws.map((w, i) =>
    OPTION_IDS.filter((o) => !scoring[i].excluded[o] && !(o === "A" && raw("A", i, 0).unavailable)),
  );
  const excludedReasons = ws.map((w, i) =>
    OPTION_IDS.filter((o) => !allowed[i].includes(o)).map((o) => ({ option: o, reason: scoring[i].excluded[o] || raw("A", i, 0).unavailable })),
  );

  // The same stack + workload set appears in many combinations: cache its monthly totals.
  const stackCache = new Map();
  const stackTotal = (o, idx, m) => {
    const key = `${o}|${idx.join(",")}|${m}`;
    if (!stackCache.has(key)) stackCache.set(key, stackMonthly(o, idx, ws, prices, m, share, raw, names).total);
    return stackCache.get(key);
  };

  const costWeight = opts.costWeight ?? (inputs.costWeightPct ?? 50) / 100;
  if (allowed.some((a) => !a.length)) return { workloads: ws, names, combos: [], recommended: null, excludedReasons };

  const evaluated = new Map();
  const evaluate = (combo) => {
    const key = combo.join("");
    if (!evaluated.has(key)) evaluated.set(key, evaluateCombo(combo));
    return evaluated.get(key);
  };
  const evaluateCombo = (combo) => {
    const groups = {};
    combo.forEach((o, i) => (groups[o] ||= []).push(i));
    const stacks = Object.keys(groups);
    let oneTime = 0;
    for (const o of stacks) oneTime += oneTimeHours(inputs, o) * inputs.engineerHourlyUsd * effortFactor(groups[o].length, inputs.extraWorkloadEffortPct);
    const monthly = [];
    for (let m = 0; m < months; m++) monthly.push(stacks.reduce((s, o) => s + stackTotal(o, groups[o], m), 0));
    const tco36 = oneTime + monthly.reduce((s, x) => s + x, 0);
    const nonCost = ws.reduce((s, w, i) => s + weightedScore(scoring[i].scores, inputs.weights, combo[i]), 0) / ws.length;
    const pv36 = oneTime + monthly.reduce((s, x, m) => s + x * pvFactor(m, inputs.discountRatePct ?? 0), 0);
    return { combo, stacks, groups, oneTime, monthly1: monthly[0], monthly, tco12: oneTime + monthly.slice(0, 12).reduce((s, x) => s + x, 0), tco36, pv36, nonCost, single: stacks.length === 1 };
  };

  const totalCombos = allowed.reduce((p, a) => p * a.length, 1);
  const exhaustive = ws.length <= (opts.exhaustiveLimit ?? EXHAUSTIVE_LIMIT);
  if (exhaustive) {
    for (const combo of assignments(ws.length)) if (combo.every((o, i) => allowed[i].includes(o))) evaluate(combo);
  } else {
    localSearch({ ws, allowed, evaluate, raw, inputs, scoring, costWeight, months });
  }
  const combos = [...evaluated.values()];

  // Ranked on present value (money later is worth less than money now).
  const minPv = Math.min(...combos.map((c) => c.pv36));
  for (const c of combos) {
    c.costScore = minPv / c.pv36;
    c.finalScore = costWeight * c.costScore + (1 - costWeight) * c.nonCost;
  }
  const byScore = [...combos].sort((a, b) => b.finalScore - a.finalScore);
  const recommended = byScore[0];
  const bestSingle = byScore.find((c) => c.single) || null;
  const bestMix = byScore.find((c) => !c.single) || null;
  const cheapest = [...combos].sort((a, b) => a.tco36 - b.tco36)[0];

  // Month-1 detail for the recommended combination: lines per stack and value per workload.
  const detail = describe(recommended, ws, prices, share, raw, names);

  // Pooling: does putting every workload on one self-hosted stack beat one API stack, and when?
  const pooling = poolingInsight(combos, ws, raw, months);

  return {
    workloads: ws,
    names,
    share,
    costWeight,
    search: { method: exhaustive ? "exhaustive" : "local", evaluated: combos.length, total: totalCombos },
    combos: byScore,
    recommended,
    bestSingle,
    bestMix,
    cheapest,
    detail,
    pooling,
    excludedReasons,
  };
}

/**
 * Local search for many workloads. Starts: every single stack, and every workload on its own best
 * option. From each start, repeatedly move one workload to another option while the score improves.
 * The score uses the cheapest start as the cost reference, so it is fixed during the search.
 */
function localSearch({ ws, allowed, evaluate, raw, inputs, scoring, costWeight, months }) {
  const starts = [];
  for (const o of OPTION_IDS) if (allowed.every((a) => a.includes(o))) starts.push(ws.map(() => o));
  // Each workload's best option on its own (36-month cost of running it alone, plus non-cost score).
  const own = ws.map((w, i) => {
    const tco = Object.fromEntries(
      allowed[i].map((o) => {
        let t = oneTimeHours(inputs, o) * inputs.engineerHourlyUsd;
        for (let m = 0; m < months; m++) t += raw(o, i, m).total * pvFactor(m, inputs.discountRatePct ?? 0);
        return [o, t];
      }),
    );
    const min = Math.min(...Object.values(tco));
    return allowed[i].reduce((best, o) => {
      const s = costWeight * (min / tco[o]) + (1 - costWeight) * weightedScore(scoring[i].scores, inputs.weights, o);
      return s > best.s ? { o, s } : best;
    }, { o: allowed[i][0], s: -Infinity }).o;
  });
  starts.push(own);
  const evaluatedStarts = starts.map(evaluate);
  const refPv = Math.min(...evaluatedStarts.map((c) => c.pv36));
  const objective = (c) => costWeight * (refPv / c.pv36) + (1 - costWeight) * c.nonCost;
  for (let cur of evaluatedStarts) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < ws.length; i++) {
        for (const o of allowed[i]) {
          if (o === cur.combo[i]) continue;
          const next = cur.combo.slice();
          next[i] = o;
          const cand = evaluate(next);
          if (objective(cand) > objective(cur) + 1e-12) {
            cur = cand;
            improved = true;
          }
        }
      }
    }
  }
}

/**
 * Month-1 lines per stack, and each workload's value with the stack's cost allocated to it
 * in proportion to the workload's own variable cost (equal split if there is none).
 */
function describe(combo, ws, prices, share, raw, names) {
  const stacks = combo.stacks.map((o) => {
    const idx = combo.groups[o];
    const r = stackMonthly(o, idx, ws, prices, 0, share, raw, names);
    const oneTime = oneTimeHours(ws[0], o) * ws[0].engineerHourlyUsd * effortFactor(idx.length, ws[0].extraWorkloadEffortPct);
    const own = idx.map((i) => r.lines.filter((l) => l.workload === i).reduce((s, l) => s + l.usd, 0));
    const ownTotal = own.reduce((s, x) => s + x, 0);
    const weights = own.map((x) => (ownTotal > 0 ? x / ownTotal : 1 / idx.length));
    return { option: o, label: OPTION_LABELS[o], workloads: idx, monthly: r.total, lines: r.lines, gpus: r.gpus, oneTime, weights, priceIds: r.priceIds };
  });
  const perWorkload = ws.map((w, i) => {
    const s = stacks.find((x) => x.workloads.includes(i));
    const k = s.workloads.indexOf(i);
    const monthly = s.monthly * s.weights[k];
    const oneTime = s.oneTime * s.weights[k];
    const agent = isAgent(w);
    const internal = isInternal(w);
    return { index: i, name: names[i], option: s.option, monthly, oneTime, agent: agent || internal, value: valueForInputs(w, volume(w, 0), monthly, oneTime, { agent, internal }) };
  });
  return { stacks, perWorkload };
}

/** First month a single self-hosted stack is cheaper than a single API stack, combined and per workload. */
function poolingInsight(combos, ws, raw, months) {
  const all = (o) => combos.find((c) => c.single && c.stacks[0] === o);
  const api = all("B");
  const self = all("C");
  if (!api || !self) return null;
  const firstCheaper = (a, b) => a.findIndex((x, m) => x < b[m]);
  const combined = firstCheaper(self.monthly, api.monthly);
  const alone = ws.map((w, i) => {
    const s = [];
    const p = [];
    for (let m = 0; m < months; m++) {
      s.push(raw("C", i, m).total);
      p.push(raw("B", i, m).total);
    }
    return firstCheaper(s, p);
  });
  return { combinedMonth: combined >= 0 ? combined + 1 : null, aloneMonths: alone.map((x) => (x >= 0 ? x + 1 : null)) };
}

/** "A, B and C" */
const listJoin = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "API for chatbot, SaaS for invoice agent" or "one API stack for all 3 workloads". */
export function describeCombo(c, names) {
  if (c.single) return `one ${OPTION_LABELS[c.stacks[0]]} stack for ${names.length === 2 ? "both" : `all ${names.length}`} workloads`;
  return c.stacks.map((o) => `${SHORT_LABELS[o]} for ${listJoin(c.groups[o].map((i) => names[i]))}`).join("; ");
}

/** Plain-language portfolio summary from templates. */
export function explainPortfolio(p, money) {
  if (!p.recommended) return ["No combination is viable with the current constraints."];
  const out = [];
  const r = p.recommended;
  out.push(`Recommended: ${describeCombo(r, p.names)}. It costs about ${money(r.monthly1)}/month and ${money(r.tco36)} over 36 months, including ${money(r.oneTime)} to build.`);
  if (p.bestSingle && p.bestMix) {
    const s = p.bestSingle;
    const x = p.bestMix;
    const diff = x.tco36 - s.tco36;
    const cmp = Math.abs(diff) < 1 ? "costs the same as" : diff < 0 ? `saves ${money(-diff)} over 36 months compared with` : `costs ${money(diff)} more over 36 months than`;
    const mixText = x === r ? "the recommendation above" : describeCombo(x, p.names);
    const singleText = s === r ? "the recommendation above" : describeCombo(s, p.names);
    out.push(`Best single stack (${singleText}): ${money(s.tco36)} over 36 months. Best mix (${mixText}): ${money(x.tco36)}, which ${cmp} the single stack.`);
    if (r === x && diff > 0) out.push("The mix is still recommended because it scores better on time to launch, team fit, privacy or quality for the workloads it splits.");
    if (r === s && diff < 0) out.push("The single stack is still recommended: one vendor, one skill set and one set of infrastructure outweigh the savings from mixing.");
  }
  if (p.cheapest !== r && p.cheapest !== p.bestMix && p.cheapest !== p.bestSingle) out.push(`The cheapest combination (${describeCombo(p.cheapest, p.names)}, ${money(p.cheapest.tco36)}) scores lower once non-cost factors are weighed.`);
  if (p.search?.method === "local") {
    out.push(`With ${p.names.length} workloads there are ${p.search.total.toLocaleString("en-US")} possible combinations; the tool checked ${p.search.evaluated.toLocaleString("en-US")} of them, starting from each single stack and each workload's own best option and improving one workload at a time.`);
  }
  if (p.pooling) {
    const { combinedMonth, aloneMonths } = p.pooling;
    const aloneAny = aloneMonths.some((m) => m != null);
    if (combinedMonth != null && !aloneAny) out.push(`Pooled together, the workloads make one self-hosted stack cheaper than one API stack from month ${combinedMonth}; none of them would get there on its own.`);
    else if (combinedMonth != null) out.push(`One self-hosted stack for everything becomes cheaper than one API stack from month ${combinedMonth}.`);
    else out.push("Even pooled together, the workloads do not reach the volume where self-hosting beats APIs within 36 months.");
  }
  return out;
}
