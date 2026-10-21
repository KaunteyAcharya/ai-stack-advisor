import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDefaults, useCaseDefaults } from "../engine/inputs.js";
import { simulate, tornado, factorsFor, triangular, rng, percentile, summarize, applyFactors } from "../engine/simulate.js";
import { TEST_PRICES } from "./fixtures.js";

const usecases = JSON.parse(readFileSync(new URL("../data/usecases.json", import.meta.url)));
const invoice = (extra = {}) => withDefaults({ ...useCaseDefaults("invoice_processing", usecases), region: "US", growthPct: 0, engineerHourlyUsd: 10, staffHourlyUsd: 20, ...extra });

test("triangular draws stay within bounds and centre on the mode", () => {
  const u = rng(42);
  const xs = Array.from({ length: 4000 }, () => triangular(u(), 10, 20, 40));
  assert.ok(xs.every((x) => x >= 10 && x <= 40));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - (10 + 20 + 40) / 3) < 0.6, `mean ${mean}`);
  assert.equal(triangular(0.5, 5, 5, 5), 5);
});

test("percentiles interpolate", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([0, 10], 0.1), 1);
});

test("factors: engine assumptions always; inputs only when applicable (and, for simulation, marked)", () => {
  const all = factorsFor(invoice()).map((f) => f.id);
  assert.ok(all.includes("tasksPerMonth") && all.includes("successPct"));
  assert.ok(!all.includes("usersPerDay") && !all.includes("conversionPct"), "chat inputs don't apply to agents");
  assert.ok(all.includes("llmPrice") && all.includes("staffHourly"));
  const marked = factorsFor(invoice(), { onlyKeys: ["successPct"] }).map((f) => f.id);
  assert.ok(marked.includes("successPct") && !marked.includes("tasksPerMonth"));
  assert.ok(!factorsFor(withDefaults()).map((f) => f.id).includes("staffHourly"), "staff cost only for time-valued use cases");
});

test("applying factors scales prices and inputs without touching the originals", () => {
  const i = invoice();
  const before = TEST_PRICES.llm.good.input_price;
  const a = applyFactors(i, TEST_PRICES, { llmPrice: 2, engineerHourly: 1.5, successPct: 50 });
  assert.equal(a.prices.llm.good.input_price, before * 2);
  assert.equal(TEST_PRICES.llm.good.input_price, before);
  assert.equal(a.inputs.engineerHourlyUsd, i.engineerHourlyUsd * 1.5);
  assert.equal(a.inputs.successPct, 50);
  assert.equal(i.successPct, invoice().successPct);
});

test("simulation is reproducible and its win shares add up to 1", () => {
  const a = simulate(invoice({ uncertainKeys: ["successPct"] }), TEST_PRICES, { runs: 60, seed: 7 });
  const b = simulate(invoice({ uncertainKeys: ["successPct"] }), TEST_PRICES, { runs: 60, seed: 7 });
  assert.deepEqual(a.winShare, b.winShare);
  assert.equal(a.net.p50, b.net.p50);
  const total = Object.values(a.winShare).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(a.net.p10 <= a.net.p50 && a.net.p50 <= a.net.p90);
  assert.ok(a.probNetPositive >= 0 && a.probNetPositive <= 1);
});

test("marking an input as not sure widens the spread", () => {
  const sure = simulate(invoice(), TEST_PRICES, { runs: 80, seed: 3 });
  const unsure = simulate(invoice({ uncertainKeys: ["successPct", "tasksPerMonth"] }), TEST_PRICES, { runs: 80, seed: 3 });
  assert.ok(unsure.net.p90 - unsure.net.p10 > sure.net.p90 - sure.net.p10);
});

test("tornado: rows sorted by swing; the completion rate moves an agent's net benefit", () => {
  const t = tornado(invoice(), TEST_PRICES);
  assert.ok(t.rows.length >= 5);
  assert.ok(t.rows.every((r, k, a) => k === 0 || a[k - 1].swing >= r.swing));
  const success = t.rows.find((r) => r.id === "successPct");
  assert.ok(success.highNet > success.lowNet);
});

test("summary of no runs is empty, not an error", () => {
  const s = summarize([]);
  assert.equal(s.runs, 0);
  assert.equal(s.probNetPositive, null);
});
