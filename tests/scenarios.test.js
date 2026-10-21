// End-to-end worked examples (BUILD_PROMPT section 11). Uses fixed test prices and rates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyze } from "../engine/recommend.js";
import { withDefaults, regionDefaults } from "../engine/inputs.js";
import { valueMetrics } from "../engine/value.js";
import { breakevenRequests } from "../engine/breakeven.js";
import { llmCostPerRequest } from "../engine/costs.js";
import { fromUsd, toUsd } from "../assets/format.js";
import { TEST_PRICES, TEST_FX } from "./fixtures.js";

const regions = JSON.parse(readFileSync(new URL("../data/regions.json", import.meta.url)));
const rank = (r, id) => r.ranked.indexOf(id);

test("scenario 1: clinic chatbot, API vs self-hosting break-even", () => {
  const perReq = llmCostPerRequest(1500, 400, { input_price: 0.3, output_price: 2.5 });
  assert.ok(Math.abs(perReq - 0.00145) < 1e-12);
  assert.ok(Math.abs(75_000 * perReq - 108.75) < 1e-9);
  assert.equal(0.8 * 730, 584);
  assert.equal(Math.round(breakevenRequests(584, perReq)), 402_759);

  const inputs = withDefaults({
    industry: "healthcare_clinic", usersPerDay: 500, requestsPerUser: 5, inTokens: 1500, outTokens: 400,
    quality: "good", growthPct: 0, engineerHourlyUsd: 15, ticketUsd: 120, externalAllowed: "only_no_training",
  });
  const r = analyze(inputs, TEST_PRICES, { curve: false });
  assert.equal(r.volume.requestsPerMonth, 75_000);
  assert.ok(rank(r, "B") < rank(r, "C"), `ranking ${r.ranked}`);
});

test("scenario 2: D2C ₹2,000 ticket → 50 extra sales = 0.1 pp", () => {
  const v = valueMetrics({
    ticket: 2000, marginPct: 40, purchaseType: "one_time", conversationsPerMonth: 50_000, conversionPct: 3,
    humanCostPerConv: 0, deflectionPct: 0, targetSharePct: 10, optionMonthly: 40_000, oneTime: 0,
  });
  assert.equal(v.grossProfitPerSale, 800);
  assert.equal(v.breakevenExtraSales, 50);
  assert.ok(Math.abs(v.breakevenConversionUpliftPp - 0.1) < 1e-12);
});

test("scenario 3: real estate ₹65 lakh ticket → high_ticket, cost weight reduced", () => {
  const v = valueMetrics({
    ticket: 6_500_000, marginPct: 20, purchaseType: "one_time", conversationsPerMonth: 3000, conversionPct: 1,
    humanCostPerConv: 0, deflectionPct: 0, targetSharePct: 10, optionMonthly: 100_000, oneTime: 0,
  });
  assert.equal(v.grossProfitPerSale, 1_300_000);
  assert.ok(Math.abs(v.breakevenExtraSales - 0.0769) < 0.0001);

  const inputs = withDefaults({
    industry: "real_estate", usersPerDay: 100, requestsPerUser: 6, ticketUsd: toUsd(6_500_000, "INR", TEST_FX),
    marginPct: 20, purchaseType: "one_time", conversionPct: 1,
  });
  const r = analyze(inputs, TEST_PRICES, { curve: false });
  assert.equal(r.profile, "high_ticket");
  assert.equal(r.costWeight, 0.25);
  const text = r.explanation.join(" ");
  for (const w of ["quality", "response speed", "human handoff"]) assert.ok(text.includes(w), w);
});

test("scenario 4: data must not leave → SaaS and API excluded; self-hosted or hybrid recommended", () => {
  const r = analyze(withDefaults({ externalAllowed: "no", devops: "strong" }), TEST_PRICES, { curve: false });
  assert.deepEqual(r.excluded.map((x) => x.id).sort(), ["A", "B"]);
  for (const x of r.excluded) assert.match(x.reason, /may not leave/);
  assert.ok(["C", "D"].includes(r.recommended));
  const d = r.options.find((o) => o.id === "D");
  assert.ok(!d.lines.some((l) => l.label.startsWith("LLM API for") && l.usd > 0), "hybrid uses self-hosted share only");
});

test("scenario 5: no DevOps + low volume → self-hosted warned and not recommended", () => {
  const r = analyze(withDefaults({ devops: "none", usersPerDay: 50, requestsPerUser: 3 }), TEST_PRICES, { curve: false });
  const c = r.options.find((o) => o.id === "C");
  assert.ok(c.warnings.some((w) => /DevOps/.test(w)));
  assert.notEqual(r.recommended, "C");
  assert.ok(r.warnings.some((w) => w.option === "C"));
});

test("scenario 9: currency conversion round-trips and AED peg", () => {
  const eur = fromUsd(1234.56, "EUR", TEST_FX);
  assert.ok(Math.abs(toUsd(eur, "EUR", TEST_FX) - 1234.56) < 0.01);
  assert.equal(fromUsd(100, "AED", TEST_FX), 367.25);
});

test("scenario 9/10: display currency does not change rankings or break-even uplift", () => {
  const inr = withDefaults({ industry: "d2c_ecommerce", displayCurrency: "INR", ticketUsd: toUsd(2000, "INR", TEST_FX) });
  // Same business entered in EUR: the user types the EUR equivalent, which is stored as USD again.
  const eurTicket = fromUsd(toUsd(2000, "INR", TEST_FX), "EUR", TEST_FX);
  const eur = { ...inr, displayCurrency: "EUR", region: "DE", ticketUsd: toUsd(eurTicket, "EUR", TEST_FX) };
  const a = analyze(inr, TEST_PRICES, { curve: false });
  const b = analyze(eur, TEST_PRICES, { curve: false });
  // region also changes telephony/residency defaults only if the user changes them; keep residency equal
  assert.deepEqual(a.ranked, b.ranked);
  assert.equal(a.recommended, b.recommended);
  const ua = a.options.find((o) => o.id === a.recommended).value.breakevenConversionUpliftPp;
  const ub = b.options.find((o) => o.id === b.recommended).value.breakevenConversionUpliftPp;
  assert.ok(Math.abs(ua - ub) < 1e-9);

  // Scenario 10 arithmetic: ₹40,000/month AI cost in EUR still needs 50 extra sales.
  const toEur = (inrAmount) => fromUsd(toUsd(inrAmount, "INR", TEST_FX), "EUR", TEST_FX);
  const v = valueMetrics({
    ticket: toEur(2000), marginPct: 40, conversationsPerMonth: 50_000, conversionPct: 3,
    humanCostPerConv: 0, deflectionPct: 0, targetSharePct: 10, optionMonthly: toEur(40_000), oneTime: 0,
  });
  assert.ok(Math.abs(v.breakevenExtraSales - 50) < 1e-9);
});

test("scenario 12: region defaults", () => {
  const de = regionDefaults("DE", regions);
  assert.equal(de.displayCurrency, "EUR");
  assert.equal(de.locale, "de-DE");
  assert.equal(de.residency, "eu_eea");
  const ae = regionDefaults("AE", regions);
  assert.equal(ae.displayCurrency, "AED");
  assert.equal(ae.residency, "uae");
  const inr = regionDefaults("IN", regions);
  assert.equal(inr.displayCurrency, "INR");
  assert.equal(inr.residency, "india");
});

test("scenario 2 (LTV line): repeat buyers 3×/year → ~17 new customers/month", () => {
  const inputs = withDefaults({ industry: "d2c_ecommerce", purchaseType: "repeat", purchasesPerYear: 3 });
  const r = analyze(inputs, TEST_PRICES, { curve: false });
  const v = r.options.find((o) => o.id === r.recommended).value;
  assert.ok(v.hasLtvLine);
  assert.equal(v.ltvCustomersNeeded, Math.ceil(v.breakevenExtraSales / 3 - 1e-9));
  assert.ok(r.explanation.some((s) => s.includes("new customers/month") && s.includes("12 months")));
});

test("robustness: reports robust or a close call naming the deciding factor", () => {
  const r = analyze(withDefaults(), TEST_PRICES, { curve: false });
  assert.equal(typeof r.robustness.robust, "boolean");
  const text = r.explanation.join(" ");
  assert.ok(text.includes("Robust:") || text.includes("Close call, decided by"));
  for (const f of r.robustness.flips) assert.notEqual(f.winner, r.recommended);
});

test("robustness: a near tie flips when one weight moves", async () => {
  const { robustnessCheck } = await import("../engine/recommend.js");
  const scores = { privacy: { A: 5, B: 0, C: 0, D: 0 }, timeToLaunch: { A: 0, B: 5, C: 0, D: 0 }, teamFit: { A: 0, B: 0, C: 0, D: 0 }, quality: { A: 0, B: 0, C: 0, D: 0 }, lockIn: { A: 0, B: 0, C: 0, D: 0 }, scalability: { A: 0, B: 0, C: 0, D: 0 } };
  const out = robustnessCheck({ costScores: { A: 0, B: 0, C: 0, D: 0 }, scores, weights: { privacy: 51, timeToLaunch: 49 }, costWeight: 0, excluded: {} });
  assert.equal(out.robust, false);
  assert.ok(out.flips.some((f) => f.factor === "privacy" && f.direction === "down" && f.winner === "B"));
});

test("deflection sensitivity: savings rise with deflection; per-resolution SaaS cost rises too", () => {
  const r = analyze(withDefaults({ seats: 3 }), TEST_PRICES, { curve: false });
  const rows = r.deflectionSensitivity;
  assert.deepEqual(rows.map((x) => x.deflectionPct), [20, 40, 60, 80]);
  assert.ok(rows[3].supportSavings > rows[0].supportSavings);
  assert.ok(rows[3].saasMonthly > rows[0].saasMonthly);
});

test("document processing: SaaS excluded when no plan fits the use case", () => {
  const r = analyze(withDefaults({ useCase: "document_processing", docsPerMonth: 2000 }), TEST_PRICES, { curve: false });
  assert.ok(r.excluded.some((x) => x.id === "A"));
});

test("region guessed from browser locale", async () => {
  const { regionFromLocales } = await import("../engine/inputs.js");
  assert.equal(regionFromLocales(["de-DE", "en"], regions), "DE");
  assert.equal(regionFromLocales(["en-GB"], regions), "GB");
  assert.equal(regionFromLocales(["en-IN"], regions), "IN");
  assert.equal(regionFromLocales(["fr"], regions), "FR");
  assert.equal(regionFromLocales(["zh-Hant-TW", "ja"], regions), "US");
});

test("growth stops after growthMonths; TCO-36 at no growth is reported", () => {
  const inputs = withDefaults({ growthPct: 10, growthMonths: 12 });
  const r = analyze(inputs, TEST_PRICES, { curve: false });
  const b = r.options.find((o) => o.id === "B");
  assert.ok(b.tco36NoGrowth < b.tco36);
  assert.ok(Math.abs(r.tco.B.monthly[12] - r.tco.B.monthly[35]) < 1e-6, "flat after month 12");
  assert.ok(r.tco.B.monthly[11] < r.tco.B.monthly[12]);
});

test("support savings apply only to conversations that reach a human", () => {
  const all = analyze(withDefaults({ humanSharePct: 100 }), TEST_PRICES, { curve: false });
  const some = analyze(withDefaults({ humanSharePct: 20 }), TEST_PRICES, { curve: false });
  const s = (r) => r.options.find((o) => o.id === "B").value.supportSavings;
  assert.ok(Math.abs(s(some) - 0.2 * s(all)) < 1e-6);
});

test("hybrid split: automatic picks the cheapest 36-month cost; manual is respected", async () => {
  const { cheapestHybridSplit } = await import("../engine/recommend.js");
  const inputs = withDefaults({ shareSelfPct: null });
  const best = cheapestHybridSplit(inputs, TEST_PRICES);
  const min = Math.min(...best.rows.map((r) => r.tco36));
  assert.equal(best.rows.find((r) => r.pct === best.bestPct).tco36, min);
  const r = analyze(inputs, TEST_PRICES, { curve: false });
  assert.equal(r.hybrid.mode, "auto");
  assert.equal(r.hybrid.pct, best.bestPct);
  assert.equal(analyze(withDefaults({ shareSelfPct: 70 }), TEST_PRICES, { curve: false }).hybrid.pct, 70);
  assert.equal(analyze(withDefaults({ externalAllowed: "no" }), TEST_PRICES, { curve: false }).hybrid.pct, 100);
});

test("explanation numbers use the page's number formatter", () => {
  const de = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
  const r = analyze(withDefaults(), TEST_PRICES, { curve: false, formatNumber: (n) => de.format(n) });
  assert.ok(r.explanation[0].includes(de.format(r.volume.requestsPerMonth)), r.explanation[0]);
});
