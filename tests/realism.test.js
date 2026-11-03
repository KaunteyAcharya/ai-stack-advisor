import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TEST_PRICES } from "./fixtures.js";
import { gpuSizing, gpusNeeded, selectGpu, kvTokensPerGpu } from "../engine/capacity.js";
import { indexPrices } from "../engine/prices.js";
import { withDefaults } from "../engine/inputs.js";
import { gpuPlan, volume } from "../engine/costs.js";
import { pooledGpu } from "../engine/portfolio.js";
import { agentValue, valueMetrics } from "../engine/value.js";
import { analyze, measuredQuality, switchPoint } from "../engine/recommend.js";
import { drawFactors, normalCdf, rng, factorsFor, applyFactors, CORRELATED } from "../engine/simulate.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const REAL = indexPrices(load("prices.json"), load("fx.json"), load("selfhost.json"));
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);

/* ---------- 1. GPU sizing: prompt reading, answer writing, memory ---------- */

test("reading the prompt takes GPU time too", () => {
  // 10 rps: prefill 10 × 1000 / 2000 = 5 GPUs, decode 10 × 400 / 400 = 10 → 15 × 1.3 = 19.5 → 20
  const base = { peakRequestsPerSec: 10, outTokens: 400, gpuTokensPerSec: 400, inTokens: 1000, prefillTokensPerSec: 2000 };
  assert.equal(gpusNeeded(base), 20);
  assert.equal(gpuSizing(base).bound, "decode");
  // Half the prompt repeats and is served from the prefix cache: prefill 2.5 → 12.5 × 1.3 → 17
  assert.equal(gpusNeeded({ ...base, cachedShare: 0.5 }), 17);
  // Without a prefill speed in the data, only output tokens count (the old formula).
  assert.equal(gpusNeeded({ ...base, prefillTokensPerSec: 0 }), 13);
});

test("long prompts can need more GPUs for memory than for compute", () => {
  const s = gpuSizing({ peakRequestsPerSec: 2, outTokens: 400, gpuTokensPerSec: 400, inTokens: 30000, prefillTokensPerSec: 4000, kvGbPerGpu: 5, kvMbPerToken: 0.125, streamTokensPerSec: 30 });
  // concurrent = 2 × (7.5 + 13.3) ≈ 41.7; memory = 41.7 × 30,200 × 0.125 / 1024 / 5 ≈ 30.7 GPUs; compute = 15 + 2 = 17
  close(s.concurrent, 2 * (30000 / 4000 + 400 / 30));
  assert.equal(s.bound, "memory");
  assert.ok(s.memory > s.prefill + s.decode);
  assert.equal(s.gpus, Math.ceil(s.memory * 1.3));
});

test("the GPU must hold one request's context; otherwise a roomier GPU is chosen", () => {
  const selfhost = load("selfhost.json");
  const gpus = REAL.gpu;
  const small = selectGpu("basic", selfhost, gpus, 2000);
  assert.equal(small.gpuClass, "l4");
  assert.ok(small.contextFits);
  const room = kvTokensPerGpu(gpus.l4, selfhost.model_classes.small, selfhost);
  const big = selectGpu("basic", selfhost, gpus, room + 1);
  assert.notEqual(big.gpuClass, "l4");
  assert.ok(big.contextFits);
  assert.equal(selectGpu("basic", selfhost, gpus, 10_000_000).contextFits, false);
});

test("real data: every model fits its GPU with KV-cache room, and longer prompts need more GPUs", () => {
  const selfhost = load("selfhost.json");
  for (const q of ["basic", "good", "best_available"]) {
    const sel = selectGpu(q, selfhost, REAL.gpu);
    assert.ok(kvTokensPerGpu(REAL.gpu[sel.gpuClass], sel.model, selfhost) > 32_000, q);
    assert.ok(REAL.throughput[sel.gpuClass].prefill_tokens_per_second > 0, q);
  }
  const short = withDefaults({ usersPerDay: 30000, inTokens: 1500, cachedSharePct: 0 });
  const long = withDefaults({ usersPerDay: 30000, inTokens: 8000, cachedSharePct: 0 });
  assert.ok(gpuPlan(long, REAL, volume(long, 0)).gpus > gpuPlan(short, REAL, volume(short, 0)).gpus);
});

test("several workloads pool prompt, answer and memory load; one workload matches its own sizing", () => {
  const w = withDefaults({ usersPerDay: 30000, inTokens: 6000 });
  assert.equal(pooledGpu([w], REAL, 0, 1).gpus, gpuPlan(w, REAL, volume(w, 0)).gpus);
  assert.ok(pooledGpu([w, w], REAL, 0, 1).gpus >= gpuPlan(w, REAL, volume(w, 0)).gpus);
});

/* ---------- 2. Time freed vs money saved ---------- */

const AGENT = { tasksPerMonth: 1000, humanMinutesPerTask: 6, successPct: 80, reviewPct: 20, reviewMinutes: 2, errorPct: 1, costPerError: 10, staffHourly: 30, fteHoursPerMonth: 160, optionMonthly: 200, oneTime: 2000 };

test("only the share of time freed you set counts as money saved; errors still cost in full", () => {
  const all = agentValue(AGENT);
  const half = agentValue({ ...AGENT, realisedPct: 50 });
  close(half.timeValue, all.timeValue);
  close(half.benefit, all.timeValue * 0.5 - all.errorCost);
  assert.ok(half.breakevenSuccessPct > all.breakevenSuccessPct);
  const chat = { ticket: 50, marginPct: 40, conversationsPerMonth: 1000, conversionPct: 2, humanCostPerConv: 1, humanSharePct: 50, deflectionPct: 60, targetSharePct: 10, optionMonthly: 100, oneTime: 0 };
  close(valueMetrics({ ...chat, realisedPct: 25 }).supportSavings, valueMetrics(chat).supportSavings * 0.25);
  const r = analyze(withDefaults({ useCase: "invoice_processing", cashSavingsPct: 60 }), TEST_PRICES, { curve: false });
  assert.ok(r.explanation.some((s) => /counting 60% of the .* of time freed as money saved/.test(s)));
});

/* ---------- 3. Your own test results and cost per successful task ---------- */

test("test results replace the assumed gap; agents use the API result as completion rate", () => {
  const i = measuredQuality(withDefaults({ useCase: "invoice_processing", openModelGapPct: 10, evalApiSuccessPct: 92, evalOpenSuccessPct: 85 }));
  assert.equal(i.openModelGapPct, 7);
  assert.equal(i.successPct, 92);
  assert.equal(measuredQuality(withDefaults({ evalApiSuccessPct: 80, evalOpenSuccessPct: 90 })).openModelGapPct, 0, "never negative");
  assert.equal(measuredQuality(withDefaults({ evalApiSuccessPct: 80 })).qualityMeasured, undefined, "both needed");
});

test("cost per completed task: month-1 cost ÷ tasks done, lower success for open models", () => {
  const i = withDefaults({ useCase: "invoice_processing", evalApiSuccessPct: 90, evalOpenSuccessPct: 80, llmPriceChangePct: 0, gpuPriceChangePct: 0 });
  const r = analyze(i, TEST_PRICES, { curve: false });
  const by = Object.fromEntries(r.options.map((o) => [o.id, o]));
  const tasks = r.volume.tasks;
  close(by.B.costPerSuccess, by.B.monthly / (tasks * 0.9));
  close(by.E.costPerSuccess, by.E.monthly / (tasks * 0.8));
  assert.equal(r.quality.measured, true);
  assert.equal(r.quality.gapPct, 10);
  // Chat without test results has no success rate, so no cost per success.
  assert.equal(analyze(withDefaults(), TEST_PRICES, { curve: false }).options[1].costPerSuccess, null);
  // With test results, chat gets a cost per correct answer.
  const chat = analyze(withDefaults({ evalApiSuccessPct: 95, evalOpenSuccessPct: 90 }), TEST_PRICES, { curve: false });
  close(chat.options[1].costPerSuccess, chat.options[1].monthly / (chat.volume.requestsPerMonth * 0.95));
});

/* ---------- 4. Switch point ---------- */

test("switch point: first month from which another option stays cheaper", () => {
  const tco = {
    B: { monthly: [100, 120, 140, 160, 180, 200] },
    C: { monthly: [150, 150, 150, 150, 150, 150] },
    A: { monthly: [90, 90, 90, 90, 90, 90] }, // already cheaper: lost on other criteria, not a switch
  };
  const s = switchPoint(withDefaults({ growthPct: 10 }), tco, "B", ["A", "B", "C"], 6);
  assert.equal(s.option, "C");
  assert.equal(s.month, 4);
  const dip = { B: { monthly: [100, 160, 100, 160] }, C: { monthly: [150, 150, 150, 150] } };
  assert.equal(switchPoint(withDefaults(), dip, "B", ["B", "C"], 4).month, 4, "must stay cheaper to the end");
  assert.equal(switchPoint(withDefaults(), { B: { monthly: [1, 1] }, C: { monthly: [2, 2] } }, "B", ["B", "C"], 2), null);
});

test("with steady growth an API build hands over to self-hosting, and the report says when", () => {
  const i = withDefaults({ usersPerDay: 2000, growthPct: 15, growthMonths: 36, llmPriceChangePct: 0, gpuPriceChangePct: 0 });
  const r = analyze(i, TEST_PRICES, { curve: false });
  assert.equal(r.recommended, "B");
  assert.equal(r.switchAt.option, "C");
  const c = r.tco.C.monthly;
  const b = r.tco.B.monthly;
  const m = r.switchAt.month - 1;
  assert.ok(c[m] < b[m] && !(c[m - 1] < b[m - 1]), "first month of the lasting crossover");
  close(r.switchAt.requestsPerMonth, volume(i, m).requestsPerMonth);
  assert.ok(r.explanation.some((s) => s.startsWith(`Switch point: with 15% monthly growth, Self-hosted open source becomes cheaper per month than API-based custom build from month ${r.switchAt.month}`)));
  assert.equal(analyze(withDefaults({ growthPct: 0, llmPriceChangePct: 0, gpuPriceChangePct: 0 }), TEST_PRICES, { curve: false }).switchAt, null);
});

/* ---------- 5. Correlated simulation draws ---------- */

const corr = (xs, ys) => {
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = ys.reduce((a, b) => a + b) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < xs.length; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
};

test("normal CDF is accurate", () => {
  close(normalCdf(0), 0.5, 1e-7);
  close(normalCdf(1.959964), 0.975, 1e-6);
  close(normalCdf(-1), 0.158655, 1e-5);
});

test("AI and GPU prices move together in the simulation; unrelated factors do not", () => {
  const factors = factorsFor(withDefaults({ useCase: "invoice_processing" }));
  const u = rng(7);
  const draws = Array.from({ length: 4000 }, () => drawFactors(factors, u));
  const col = (id) => draws.map((d) => d[id]);
  const prices = corr(col("llmPrice"), col("gpuPrice"));
  assert.ok(prices > 0.3 && prices < 0.65, `prices ${prices}`);
  assert.ok(corr(col("engineerHourly"), col("staffHourly")) > 0.5);
  assert.ok(Math.abs(corr(col("llmPrice"), col("gpuThroughput"))) < 0.08);
  for (const g of CORRELATED) for (const id of g.ids) assert.ok(factors.some((f) => f.id === id) || id === "staffHourly", id);
  // Each draw stays inside its factor's range.
  const f = factors.find((x) => x.id === "gpuPrice");
  assert.ok(col("gpuPrice").every((x) => x >= f.low && x <= f.high));
});

test("simulation varies the measured quality gap by moving the open-model test result", () => {
  const i = withDefaults({ evalApiSuccessPct: 90, evalOpenSuccessPct: 84 });
  assert.equal(factorsFor(i).find((f) => f.id === "openModelGap").mode, 6);
  const a = applyFactors(i, TEST_PRICES, { openModelGap: 15 }).inputs;
  assert.equal(a.evalOpenSuccessPct, 75);
  assert.equal(measuredQuality(a).openModelGapPct, 15);
  assert.equal(applyFactors(withDefaults(), TEST_PRICES, { cashSavings: 70 }).inputs.cashSavingsPct, 70);
});
