import { test } from "node:test";
import assert from "node:assert/strict";
import { valueMetrics, customerValue12m, classifyProfile } from "../engine/value.js";

const base = {
  ticket: 2000, marginPct: 40, purchaseType: "one_time", conversationsPerMonth: 50_000, conversionPct: 3,
  humanCostPerConv: 0, deflectionPct: 0, targetSharePct: 10, optionMonthly: 40_000, oneTime: 100_000,
};

test("12-month customer value: one-time, repeat, direct override", () => {
  assert.equal(customerValue12m({ ticket: 2000, marginPct: 40 }), 800);
  assert.equal(customerValue12m({ ticket: 2000, marginPct: 40, purchaseType: "repeat", purchasesPerYear: 3 }), 2400);
  assert.equal(customerValue12m({ ticket: 2000, marginPct: 40, ltv: 5000 }), 5000);
});

test("headline break-even uses first-sale profit; LTV line uses 12-month value; both rounded up", () => {
  const v = valueMetrics({ ...base, purchaseType: "repeat", purchasesPerYear: 3 });
  assert.equal(v.breakevenExtraSales, 50);
  assert.equal(v.salesNeeded, 50);
  assert.ok(Math.abs(v.ltvBreakevenCustomers - 16.667) < 0.001);
  assert.equal(v.ltvCustomersNeeded, 17);
  assert.equal(v.hasLtvLine, true);
  assert.equal(valueMetrics({ ...base, optionMonthly: 40_001 }).salesNeeded, 51);
});

test("value metrics", () => {
  const v = valueMetrics(base);
  assert.equal(v.grossProfitPerSale, 800);
  assert.equal(v.valuePerConversation, 24);
  assert.ok(Math.abs(v.acceptableAiCostPerConversation - 2.4) < 1e-9);
  assert.equal(v.aiCostPerConversation, 0.8);
  assert.equal(v.salesPerMonth, 1500);
  assert.ok(Math.abs(v.aiCostPctOfTicket - (40_000 / 1500 / 2000) * 100) < 1e-9);
});

test("ROI and payback", () => {
  const v = valueMetrics({ ...base, humanCostPerConv: 1, deflectionPct: 50 }); // savings 25,000
  // uplift 1pp → 500 extra sales × 800 = 400,000; net = 400,000 + 25,000 − 40,000 = 385,000
  assert.ok(Math.abs(v.roiAt(1) - 385_000 / 40_000) < 1e-9);
  assert.ok(Math.abs(v.paybackAt(1) - 100_000 / 385_000) < 1e-9);
  assert.equal(v.paybackAt(0), null); // 25,000 savings < 40,000 cost → never
  assert.deepEqual(v.sensitivity.map((s) => s.upliftPp), [0, 0.5, 1, 2, 5]);
});

test("profile classification thresholds (USD)", () => {
  assert.equal(classifyProfile(20, 50_000), "low_ticket_high_volume");
  assert.equal(classifyProfile(20, 5_000), "mid_ticket");
  assert.equal(classifyProfile(10_000, 100), "high_ticket");
  assert.equal(classifyProfile(500, 50_000), "mid_ticket");
});

test("tiny uplifts are not shown as 0.00", async () => {
  const { formatPp } = await import("../engine/value.js");
  assert.equal(formatPp(0.1), "0.10");
  assert.equal(formatPp(0.0025641), "0.0026");
  assert.equal(formatPp(0), "0.00");
});
