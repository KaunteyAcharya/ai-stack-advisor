// Prompt caching, evaluation hours, present value and the open-model quality gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDefaults, useCaseDefaults } from "../engine/inputs.js";
import { llmCostPerRequest, cachedShareFor, apiMonthly } from "../engine/costs.js";
import { projectTco, pvFactor } from "../engine/tco.js";
import { analyze, qualityAdjusted } from "../engine/recommend.js";
import { indexPrices } from "../engine/prices.js";
import { TEST_PRICE_ENTRIES, TEST_FX, TEST_SELFHOST, TEST_PRICES } from "./fixtures.js";

const usecases = JSON.parse(readFileSync(new URL("../data/usecases.json", import.meta.url)));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// Fixture prices with caching on the mid tier: cached input $0.03/1M, minimum 2,048 tokens.
const CACHED = indexPrices(
  { entries: TEST_PRICE_ENTRIES.map((e) => (e.id === "llm_m" ? { ...e, cached_input_price: 0.03, cache_min_tokens: 2048 } : e)) },
  TEST_FX,
  TEST_SELFHOST,
);

test("prompt caching prices the cached share of input at the cached rate", () => {
  const model = CACHED.llm.good;
  // 3,000 in, 500 out, 40% cached: 1,800 × 0.30 + 1,200 × 0.03 + 500 × 2.50 per 1M
  close(llmCostPerRequest(3000, 500, model, 0.4), (1800 * 0.3 + 1200 * 0.03 + 500 * 2.5) / 1e6);
  close(llmCostPerRequest(3000, 500, model, 0), (3000 * 0.3 + 500 * 2.5) / 1e6);
});

test("caching only applies to prompts at or above the provider minimum", () => {
  const model = CACHED.llm.good;
  assert.equal(cachedShareFor({ cachedSharePct: 40 }, model, 1500), 0);
  assert.equal(cachedShareFor({ cachedSharePct: 40 }, model, 2048), 0.4);
  assert.equal(cachedShareFor({ cachedSharePct: 40 }, TEST_PRICES.llm.good, 5000), 0, "no cached price listed → no caching");
});

test("an agent with long prompts gets cheaper with caching; a short chatbot does not", () => {
  const agent = withDefaults({ ...useCaseDefaults("report_generation", usecases), region: "US", growthPct: 0, useBatch: false });
  const withCache = apiMonthly(agent, CACHED);
  const noCache = apiMonthly({ ...agent, cachedSharePct: 0 }, CACHED);
  assert.ok(withCache.llmMonthly < noCache.llmMonthly);
  assert.match(withCache.lines[0].label, /% of input cached/);
  const chat = withDefaults({ region: "US", growthPct: 0 }); // 1,500 input tokens < 2,048
  assert.equal(apiMonthly(chat, CACHED).llmMonthly, apiMonthly({ ...chat, cachedSharePct: 0 }, CACHED).llmMonthly);
});

test("present value: 0% discount equals the plain total; a positive rate lowers it", () => {
  const i = withDefaults({ region: "US", growthPct: 0 });
  const t0 = projectTco({ ...i, discountRatePct: 0 }, TEST_PRICES);
  const t10 = projectTco({ ...i, discountRatePct: 10 }, TEST_PRICES);
  close(t0.B.pv36, t0.B.tco36);
  assert.ok(t10.B.pv36 < t10.B.tco36);
  close(pvFactor(11, 10), 1 / 1.1); // month 12 is one year out
  close(t10.B.pv36, t10.B.oneTime + t10.B.monthly.reduce((s, x, m) => s + x / Math.pow(1.1, (m + 1) / 12), 0));
});

test("open-model quality gap: self-hosted loses completion, hybrid only on its self-hosted share", () => {
  const i = withDefaults({ successPct: 80, deflectionPct: 60, minutesSavedPerRequest: 4, openModelGapPct: 10 });
  assert.equal(qualityAdjusted(i, "B", 0.7), i);
  assert.equal(qualityAdjusted(i, "C", 0.7).successPct, 70);
  close(qualityAdjusted(i, "D", 0.5).successPct, 75);
  assert.equal(qualityAdjusted(i, "C", 1).deflectionPct, 50);
  close(qualityAdjusted(i, "C", 1).minutesSavedPerRequest, 3.6);
});

test("value an open model gives up is added to its decision cost", () => {
  const inv = withDefaults({ ...useCaseDefaults("invoice_processing", usecases), region: "US", growthPct: 0, staffHourlyUsd: 30 });
  const r0 = analyze({ ...inv, openModelGapPct: 0 }, TEST_PRICES, { curve: false });
  const r10 = analyze({ ...inv, openModelGapPct: 10 }, TEST_PRICES, { curve: false });
  const c0 = r0.options.find((o) => o.id === "C");
  const c10 = r10.options.find((o) => o.id === "C");
  close(c0.valueLostPv, 0);
  assert.ok(c10.valueLostPv > 0);
  assert.ok(c10.decisionCost > c0.decisionCost);
  assert.ok(c10.value.netHours < c0.value.netHours);
  const b10 = r10.options.find((o) => o.id === "B");
  close(b10.valueLostPv, 0);
  assert.ok(r10.explanation.some((s) => s.includes("percentage points fewer tasks")));
});

test("light analysis gives the same recommendation, without report extras", () => {
  const i = withDefaults({ region: "US" });
  const full = analyze(i, TEST_PRICES, { curve: false });
  const light = analyze(i, TEST_PRICES, { curve: false, light: true, hybridPct: full.hybrid.pct });
  assert.equal(light.recommended, full.recommended);
  assert.equal(light.explanation.length, 0);
  assert.equal(light.monthlyRange, null);
});
