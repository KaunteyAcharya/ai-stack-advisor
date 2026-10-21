import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTco, tcoFromMonthly } from "../engine/tco.js";
import { withDefaults } from "../engine/inputs.js";
import { TEST_PRICES } from "./fixtures.js";

test("TCO = one-time + sum of monthly costs", () => {
  assert.equal(tcoFromMonthly(100, [10, 20, 30], 2), 130);
});

test("with zero growth, TCO_36 = one-time + 36 × month-1 cost", () => {
  const inputs = withDefaults({ usersPerDay: 500, requestsPerUser: 5, growthPct: 0 });
  const t = projectTco(inputs, TEST_PRICES);
  for (const id of ["A", "B", "C", "D"]) {
    const r = t[id];
    assert.ok(Math.abs(r.tco36 - (r.oneTime + 36 * r.monthly[0])) < 1e-6);
    assert.ok(Math.abs(r.tco12 - (r.oneTime + 12 * r.monthly[0])) < 1e-6);
  }
});

test("GPU count steps up as volume grows", () => {
  const inputs = withDefaults({ usersPerDay: 20_000, requestsPerUser: 5, growthPct: 10 });
  const t = projectTco(inputs, TEST_PRICES);
  assert.ok(t.C.gpus[35] > t.C.gpus[0]);
  assert.ok(t.C.monthly[35] > t.C.monthly[0]);
});
