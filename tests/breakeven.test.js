import { test } from "node:test";
import assert from "node:assert/strict";
import { breakevenRequests, apiVsSelfhost, costCurve, logVolumes, findCrossovers } from "../engine/breakeven.js";
import { withDefaults } from "../engine/inputs.js";
import { TEST_PRICES } from "./fixtures.js";

test("break-even = fixed self-host monthly / API cost per request", () => {
  assert.equal(Math.round(breakevenRequests(584, 0.00145)), 402_759);
  assert.equal(breakevenRequests(584, 0), Infinity);
});

test("scenario break-even includes GPU, ops labour and self-managed DB", () => {
  const inputs = withDefaults({ usersPerDay: 500, requestsPerUser: 5, inTokens: 1500, outTokens: 400, quality: "good", engineerHourlyUsd: 10 });
  const b = apiVsSelfhost(inputs, TEST_PRICES);
  assert.ok(Math.abs(b.fixedSelfhostMonthly - (584 + 300 + 24)) < 1e-6);
  assert.ok(Math.abs(b.apiCostPerRequest - 0.00145) < 1e-9);
});

test("high availability doubles the minimum fixed GPU cost", () => {
  const inputs = withDefaults({ uptime: "high_availability", engineerHourlyUsd: 0 });
  assert.ok(Math.abs(apiVsSelfhost(inputs, TEST_PRICES).fixedSelfhostMonthly - (2 * 584 + 24)) < 1e-6);
});

test("log volumes span 1,000 to 10,000,000", () => {
  const v = logVolumes();
  assert.ok(Math.abs(v[0] - 1000) < 1e-6);
  assert.ok(Math.abs(v.at(-1) - 1e7) < 1e-3);
});

test("cost curve: API cheapest at low volume, crossover with self-hosting exists", () => {
  const inputs = withDefaults({ usersPerDay: 500, requestsPerUser: 5, quality: "good", engineerHourlyUsd: 10, growthPct: 0 });
  const c = costCurve(inputs, TEST_PRICES);
  assert.ok(c.series.B[0] < c.series.C[0]);
  const bc = c.crossovers.find((x) => x.between.join() === "B,C");
  assert.ok(bc, "B/C crossover found");
  assert.equal(bc.cheaperAbove, "C");
});

test("findCrossovers interpolates", () => {
  const x = findCrossovers([1, 100], { P: [0, 10], Q: [10, 0] });
  assert.equal(x.length, 1);
  assert.ok(Math.abs(x[0].requestsPerMonth - 10) < 1e-9);
});
