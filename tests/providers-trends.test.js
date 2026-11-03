import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TEST_PRICES, TEST_PRICE_ENTRIES, TEST_FX, TEST_SELFHOST } from "./fixtures.js";
import { indexPrices } from "../engine/prices.js";
import { withDefaults } from "../engine/inputs.js";
import {
  priceChangeFactor, apiMonthly, selfhostMonthly, hostedOpenMonthly, llmModelFor, llmCandidates, monthlyCosts, volume, requestCost,
} from "../engine/costs.js";
import { projectTco } from "../engine/tco.js";
import { analyze } from "../engine/recommend.js";
import { factorsFor, applyFactors } from "../engine/simulate.js";
import { scoreOptions } from "../engine/scoring.js";

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} ≈ ${b}`);
const flat = { llmPriceChangePct: 0, gpuPriceChangePct: 0 };

// Two providers: "cheapin" has cheap input and dear output, "cheapout" the reverse.
const llm = (o) => ({ category: "llm_api", unit: "usd_per_million_tokens", source_url: "test", last_verified: "2026-01-01", is_sample: false, label: o.id, ...o });
const MULTI = indexPrices(
  {
    default_llm_provider: "cheapin",
    entries: [
      ...TEST_PRICE_ENTRIES.filter((e) => e.category !== "llm_api"),
      ...["budget", "mid", "premium"].flatMap((tier) => [
        llm({ id: `in_${tier}`, provider: "cheapin", tier, input_price: 0.1, output_price: 4, batch_input_price: 0.05, batch_output_price: 2 }),
        llm({ id: `out_${tier}`, provider: "cheapout", tier, input_price: 1, output_price: 1 }),
      ]),
    ],
  },
  TEST_FX,
  TEST_SELFHOST,
);

test("price change compounds monthly from today's price", () => {
  assert.equal(priceChangeFactor(-30, 0), 1);
  close(priceChangeFactor(-30, 12), 0.7);
  close(priceChangeFactor(-30, 24), 0.49);
  close(priceChangeFactor(10, 6), Math.sqrt(1.1));
  assert.equal(priceChangeFactor(0, 30), 1);
});

test("LLM lines follow the AI price change; GPU lines follow the GPU price change", () => {
  const i = withDefaults({ growthPct: 0, llmPriceChangePct: -30, gpuPriceChangePct: -15 });
  const llm0 = apiMonthly(i, TEST_PRICES, 0).llmMonthly;
  close(apiMonthly(i, TEST_PRICES, 12).llmMonthly, llm0 * 0.7);
  const gpu0 = selfhostMonthly(i, TEST_PRICES, 0).gpuMonthly;
  close(selfhostMonthly(i, TEST_PRICES, 12).gpuMonthly, gpu0 * 0.85);
  // Labour and shared infrastructure do not change.
  const lab = (r) => r.lines.filter((l) => !l.llm && !l.gpu).reduce((s, l) => s + l.usd, 0);
  close(lab(apiMonthly(i, TEST_PRICES, 12)), lab(apiMonthly(i, TEST_PRICES, 0)));
});

test("falling prices lower the 36-month cost, and the report shows the flat-price figure", () => {
  const falling = projectTco(withDefaults({ llmPriceChangePct: -30, gpuPriceChangePct: -15 }), TEST_PRICES);
  const level = projectTco(withDefaults(flat), TEST_PRICES);
  for (const id of ["B", "C", "E"]) assert.ok(falling[id].tco36 < level[id].tco36, id);
  const r = analyze(withDefaults({ llmPriceChangePct: -30 }), TEST_PRICES, { curve: false });
  const best = r.options.find((o) => o.id === r.recommended);
  assert.ok(best.tco36FlatPrices > best.tco36);
  assert.ok(r.explanation.some((s) => /at today's prices throughout/.test(s)));
});

test("cheapest provider depends on the request mix", () => {
  const inputHeavy = withDefaults({ inTokens: 6000, outTokens: 100, cachedSharePct: 0 });
  const outputHeavy = withDefaults({ inTokens: 200, outTokens: 2000, cachedSharePct: 0 });
  assert.equal(llmModelFor(inputHeavy, MULTI).provider, "cheapin");
  assert.equal(llmModelFor(outputHeavy, MULTI).provider, "cheapout");
  const c = llmCandidates(outputHeavy, MULTI);
  assert.ok(c[0].perRequest <= c[1].perRequest);
  close(apiMonthly(outputHeavy, MULTI).llmCostPerRequest, c[0].perRequest);
});

test("providers without a model at the quality level are left out of the cheapest search", () => {
  const partial = indexPrices(
    { entries: [...TEST_PRICE_ENTRIES.filter((e) => e.category !== "llm_api"), llm({ id: "a_mid", provider: "a", tier: "mid", input_price: 0.01, output_price: 0.01 }), llm({ id: "b_mid", provider: "b", tier: "mid", input_price: 1, output_price: 1 }), llm({ id: "b_top", provider: "b", tier: "premium", input_price: 5, output_price: 5 })] },
    TEST_FX,
    TEST_SELFHOST,
  );
  assert.deepEqual(llmCandidates(withDefaults({ quality: "best_available" }), partial).map((c) => c.provider), ["b"]);
  assert.equal(llmModelFor(withDefaults({ quality: "best_available" }), partial).id, "b_top");
  assert.equal(llmModelFor(withDefaults({ quality: "best_available", llmProvider: "a" }), partial).id, "a_mid", "explicit choice falls back to the mid model");
});

test("a chosen provider is used even when another is cheaper", () => {
  const i = withDefaults({ inTokens: 200, outTokens: 2000, llmProvider: "cheapin" });
  assert.equal(llmModelFor(i, MULTI).provider, "cheapin");
  const r = analyze(i, MULTI, { curve: false });
  assert.equal(r.llm.api.provider, "cheapin");
  assert.equal(r.llm.candidates[0].provider, "cheapout");
});

test("batch prices count when picking the cheapest provider for a batch agent", () => {
  const agent = withDefaults({ useCase: "invoice_processing", useBatch: true, inTokensPerStep: 2000, outTokensPerStep: 1000, contextGrowthPerStep: 0, cachedSharePct: 0 });
  const m = llmModelFor(agent, MULTI);
  assert.ok(m.batch, "batch price used");
  const v = volume(agent, 0);
  for (const c of llmCandidates(agent, MULTI)) assert.ok(requestCost(agent, m, v) <= c.perRequest + 1e-12);
});

test("option E: open-model tokens + shared infrastructure + its own maintenance hours", () => {
  const i = withDefaults({ ...flat, maintenanceHours: { E: 7 } });
  const e = hostedOpenMonthly(i, TEST_PRICES);
  assert.match(e.lines[0].label, /^Hosted open model/);
  const v = volume(i, 0);
  close(e.llmMonthly, v.requestsPerMonth * requestCost(i, TEST_PRICES.openLlm.good, v));
  const labour = e.lines.find((l) => l.labour);
  close(labour.usd, 7 * i.engineerHourlyUsd);
  assert.ok(monthlyCosts(i, TEST_PRICES).E.total > 0);
});

test("option E is excluded when data must stay, and unavailable without open-model prices", () => {
  assert.match(scoreOptions(withDefaults({ externalAllowed: "no" })).excluded.E, /may not leave/);
  const noOpen = indexPrices({ entries: TEST_PRICE_ENTRIES.filter((e) => e.category !== "llm_open_hosted") }, TEST_FX, TEST_SELFHOST);
  const r = analyze(withDefaults(), noOpen, { curve: false });
  assert.ok(r.excluded.some((x) => x.id === "E" && /hosted open-model price/.test(x.reason)));
});

test("option E carries the open-model quality gap, like self-hosting", () => {
  const i = withDefaults({ useCase: "invoice_processing", openModelGapPct: 10, successPct: 80 });
  const r = analyze(i, TEST_PRICES, { curve: false });
  const by = Object.fromEntries(r.options.map((o) => [o.id, o]));
  assert.ok(by.E.valueLostPv > 0, "value lost counted");
  assert.equal(by.B.valueLostPv, 0);
});

test("simulation varies the yearly price changes around the user's values", () => {
  const i = withDefaults({ llmPriceChangePct: -80 });
  const f = factorsFor(i).find((x) => x.id === "llmPriceTrend");
  assert.equal(f.mode, -80);
  assert.ok(f.low <= -80 && f.high >= -80);
  const a = applyFactors(i, TEST_PRICES, { llmPriceTrend: -10, gpuPriceTrend: 0 });
  assert.equal(a.inputs.llmPriceChangePct, -10);
  assert.equal(a.inputs.gpuPriceChangePct, 0);
  const scaled = applyFactors(i, MULTI, { llmPrice: 2 }).prices;
  assert.equal(scaled.llmByProvider.cheapout.good.input_price, 2);
});

test("price data: every provider has budget and mid models, most have premium; hosted open models have all three; each has a cross-check", () => {
  const raw = JSON.parse(readFileSync(new URL("../data/prices.json", import.meta.url)));
  const fx = JSON.parse(readFileSync(new URL("../data/fx.json", import.meta.url)));
  const idx = indexPrices(raw, fx);
  assert.deepEqual(idx.llmProviders.map((p) => p.id).sort(), raw.llm_providers.map((p) => p.id).sort());
  for (const [p, tiers] of Object.entries(idx.llmByProvider)) for (const q of ["basic", "good"]) assert.ok(tiers[q], `${p} ${q}`);
  assert.ok(Object.values(idx.llmByProvider).filter((t) => t.best_available).length >= 3, "premium models from at least three providers");
  for (const q of ["basic", "good", "best_available"]) assert.ok(idx.openLlm[q], `open ${q}`);
  for (const e of raw.entries.filter((x) => x.category === "llm_api" || x.category === "llm_open_hosted")) {
    assert.ok(e.cross_check?.openrouter, `${e.id} cross-check`);
    if (e.intro) assert.match(e.intro.until, /^\d{4}-\d{2}-\d{2}$/, `${e.id} intro date`);
  }
});
