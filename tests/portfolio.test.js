import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDefaults, newWorkload, workloadsOf, WORKLOAD_KEYS, DEFAULT_INPUTS } from "../engine/inputs.js";
import { apiMonthly, selfhostMonthly } from "../engine/costs.js";
import { analyzePortfolio, pooledGpu, effortFactor, explainPortfolio, describeCombo } from "../engine/portfolio.js";
import { TEST_PRICES } from "./fixtures.js";

const usecases = JSON.parse(readFileSync(new URL("../data/usecases.json", import.meta.url)));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const money = (x) => `$${Math.round(x)}`;

// Chatbot + data assistant + invoice agent, no growth, US.
const base = withDefaults({ region: "US", growthPct: 0, engineerHourlyUsd: 10, usersPerDay: 500, requestsPerUser: 5 });
const two = { ...base, extraWorkloads: [newWorkload("data_assistant", base, usecases)] };
const three = { ...two, extraWorkloads: [...two.extraWorkloads, newWorkload("invoice_processing", base, usecases)] };

test("workloads share everything except their own fields", () => {
  const ws = workloadsOf(three);
  assert.equal(ws.length, 3);
  assert.deepEqual(ws.map((w) => w.useCase), ["chatbot", "data_assistant", "invoice_processing"]);
  for (const w of ws) assert.equal(w.region, "US");
  const extraKeys = Object.keys(three.extraWorkloads[0]);
  assert.ok(extraKeys.every((k) => WORKLOAD_KEYS.includes(k)), "extra workloads hold only per-workload fields");
  assert.ok(WORKLOAD_KEYS.every((k) => k in DEFAULT_INPUTS), "every workload key has a default");
});

test("effort: base plus 50% for each extra workload on the same stack", () => {
  assert.equal(effortFactor(1, 50), 1);
  assert.equal(effortFactor(3, 50), 2);
});

test("every allowed combination is evaluated: 4^n when nothing is excluded", () => {
  const p = analyzePortfolio(two, TEST_PRICES, { usecases });
  // data assistant has no SaaS plan in the fixture prices → 4 × 3 combinations
  assert.equal(p.combos.length, 12);
  assert.ok(p.combos.every((c) => c.combo[1] !== "A"));
  assert.ok(p.excludedReasons[1].some((x) => x.option === "A"));
});

test("one API stack pays shared infrastructure and base effort once", () => {
  const p = analyzePortfolio(two, TEST_PRICES, { usecases });
  const allApi = p.combos.find((c) => c.single && c.stacks[0] === "B");
  const [w1, w2] = workloadsOf(two);
  const separate = apiMonthly(w1, TEST_PRICES).total + apiMonthly(w2, TEST_PRICES).total;
  // shared: managed DB 25 + hosting 12 + vector DB 50 counted once; labour 10 h × 1.5 instead of 2 × 10 h
  close(allApi.monthly1, separate - (25 + 12 + 50) - 10 * 10 * 0.5);
});

test("self-hosted GPUs are pooled across workloads", () => {
  const busy = { ...base, usersPerDay: 30_000, extraWorkloads: [{ ...newWorkload("chatbot", base, usecases), usersPerDay: 30_000 }] };
  const [w1, w2] = workloadsOf(busy);
  const separate = selfhostMonthly(w1, TEST_PRICES).gpus + selfhostMonthly(w2, TEST_PRICES).gpus;
  const pooled = pooledGpu([w1, w2], TEST_PRICES, 0, 1).gpus;
  assert.ok(pooled <= separate, `${pooled} ≤ ${separate}`);
  const single = pooledGpu([w1], TEST_PRICES, 0, 1).gpus;
  assert.equal(single, selfhostMonthly(w1, TEST_PRICES).gpus, "pooling one workload matches the single-workload sizing");
});

test("data that must stay in-house rules out SaaS and API for every workload", () => {
  const p = analyzePortfolio({ ...three, externalAllowed: "no" }, TEST_PRICES, { usecases });
  assert.ok(p.combos.length > 0);
  assert.ok(p.combos.every((c) => c.combo.every((o) => o === "C" || o === "D")));
  assert.equal(p.share, 1);
});

test("best single stack, best mix and the recommendation are reported", () => {
  const p = analyzePortfolio(three, TEST_PRICES, { usecases });
  assert.ok(p.bestSingle.single);
  assert.ok(!p.bestMix.single);
  assert.equal(p.recommended, p.combos[0]);
  assert.ok(p.combos.every((c, i, a) => i === 0 || a[i - 1].finalScore >= c.finalScore));
  const text = explainPortfolio(p, money).join(" ");
  assert.ok(text.includes("Best single stack"));
  assert.ok(text.includes("Best mix"));
  assert.ok(describeCombo(p.bestSingle, p.names).startsWith("one "));
});

test("allocated cost per workload adds up to the stack totals", () => {
  const p = analyzePortfolio(three, TEST_PRICES, { usecases });
  const total = p.detail.perWorkload.reduce((s, w) => s + w.monthly, 0);
  close(total, p.recommended.monthly1);
  const oneTime = p.detail.perWorkload.reduce((s, w) => s + w.oneTime, 0);
  close(oneTime, p.recommended.oneTime);
  assert.equal(p.detail.perWorkload[2].value.kind, "agent");
  assert.ok(Number.isFinite(p.detail.perWorkload[0].value.supportSavings));
  assert.ok(p.detail.perWorkload[1].value.internal, "data assistant is valued on staff time saved");
});

test("internal tools: hours = requests × minutes saved / 60; break-even minutes per request", async () => {
  const { valueForInputs } = await import("../engine/value.js");
  const { volume } = await import("../engine/costs.js");
  const w = withDefaults({ ...newWorkload("data_assistant", base, usecases), region: "US", staffHourlyUsd: 30, fteHoursPerMonth: 160 });
  const vol = volume(w);
  const v = valueForInputs(w, vol, 600, 1200, { internal: true });
  close(v.netHours, (vol.requestsPerMonth * w.minutesSavedPerRequest) / 60);
  close(v.benefit, v.netHours * 30);
  close(v.breakevenMinutesPerRequest, 600 / ((vol.requestsPerMonth / 60) * 30));
  assert.deepEqual(v.sensitivity.map((s) => s.minutes), [w.minutesSavedPerRequest / 2, w.minutesSavedPerRequest, w.minutesSavedPerRequest * 2]);
});

test("pooling insight compares one self-hosted stack with one API stack", () => {
  const p = analyzePortfolio(three, TEST_PRICES, { usecases });
  assert.ok(p.pooling);
  assert.equal(p.pooling.aloneMonths.length, 3);
});

test("TCO of a combination = build cost + 36 monthly costs", () => {
  const p = analyzePortfolio(two, TEST_PRICES, { usecases });
  for (const c of p.combos) close(c.tco36, c.oneTime + c.monthly.reduce((s, x) => s + x, 0));
});

const ALL_USE_CASES = Object.keys(usecases.usecases);
const many = (n) => ({ ...base, extraWorkloads: ALL_USE_CASES.filter((u) => u !== "chatbot").slice(0, n - 1).map((u) => newWorkload(u, base, usecases)) });

test("local search finds the same answer as the full search on 5 workloads", () => {
  const full = analyzePortfolio(many(5), TEST_PRICES, { usecases });
  const local = analyzePortfolio(many(5), TEST_PRICES, { usecases, exhaustiveLimit: 3 });
  assert.equal(full.search.method, "exhaustive");
  assert.equal(local.search.method, "local");
  assert.ok(local.search.evaluated < full.search.evaluated);
  assert.ok(local.recommended.finalScore >= full.recommended.finalScore * 0.98, "within 2% of the best score");
  assert.ok(local.bestSingle, "single stacks are always evaluated");
});

test("all 11 use cases at once: quick, with a recommendation and a best single stack", () => {
  const t = performance.now();
  const p = analyzePortfolio(many(11), TEST_PRICES, { usecases });
  const ms = performance.now() - t;
  assert.equal(p.workloads.length, 11);
  assert.equal(p.search.method, "local");
  assert.ok(p.recommended && p.bestSingle);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
  assert.ok(explainPortfolio(p, money).some((s) => s.includes("possible combinations")));
});
