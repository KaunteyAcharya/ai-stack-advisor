import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withDefaults, useCaseDefaults, newWorkload } from "../engine/inputs.js";
import { RANGE_SPECS, RANGE_KEYS, applyRange, analyzeRange, rangeBounds } from "../engine/ranges.js";
import { TEST_PRICES } from "./fixtures.js";

const usecases = JSON.parse(readFileSync(new URL("../data/usecases.json", import.meta.url)));
const invoice = (extra = {}) => withDefaults({ ...useCaseDefaults("invoice_processing", usecases), region: "US", growthPct: 0, engineerHourlyUsd: 10, staffHourlyUsd: 20, ...extra });

test("schema lists exactly the range keys", () => {
  const schema = JSON.parse(readFileSync(new URL("../docs/inputs.schema.json", import.meta.url)));
  assert.deepEqual([...schema.properties.uncertainKeys.items.enum].sort(), [...RANGE_KEYS].sort());
});

test("bands: low ≤ typical ≤ high, percentages stay within 0–100", () => {
  for (const [k, s] of Object.entries(RANGE_SPECS)) {
    const isPct = k.endsWith("Pct") && k !== "growthPct";
    for (const v of isPct ? [0, 5, 50, 95, 100] : [0, 5, 50, 95, 100, 2000]) {
      const lo = s.low(v);
      const hi = s.high(v);
      assert.ok(lo <= v + 1e-9 && hi >= v - 1e-9, `${k} at ${v}: ${lo}–${hi}`);
      if (isPct) assert.ok(lo >= 0 && hi <= 100, `${k} within 0–100`);
    }
  }
  assert.deepEqual(rangeBounds("successPct", 80), { low: 60, high: 90 });
});

test("applyRange moves only the uncertain fields, in every workload", () => {
  const base = invoice({ uncertainKeys: ["successPct"], extraWorkloads: [] });
  const two = { ...base, extraWorkloads: [newWorkload("ticket_triage", base, usecases)] };
  const low = applyRange(two, "low");
  assert.equal(low.successPct, two.successPct - 20);
  assert.equal(low.extraWorkloads[0].successPct, two.extraWorkloads[0].successPct - 20);
  assert.equal(low.tasksPerMonth, two.tasksPerMonth, "fields not marked stay the same");
});

test("no uncertain inputs → no range", () => {
  assert.equal(analyzeRange(invoice(), TEST_PRICES), null);
});

test("time saved and net benefit spread with the completion rate", () => {
  const r = analyzeRange(invoice({ uncertainKeys: ["successPct", "humanMinutesPerTask"] }), TEST_PRICES);
  const [lo, hi] = r.span("netHours");
  assert.ok(lo < r.cases.typical.netHours && r.cases.typical.netHours < hi);
  assert.equal(lo, r.cases.low.netHours);
  assert.equal(hi, r.cases.high.netHours);
  const [nlo, nhi] = r.span("net");
  assert.ok(nlo < nhi);
});

test("portfolio ranges cover all workloads", () => {
  const base = invoice({ uncertainKeys: ["tasksPerMonth"] });
  const two = { ...base, extraWorkloads: [newWorkload("ticket_triage", base, usecases)] };
  const r = analyzeRange(two, TEST_PRICES, { usecases });
  assert.ok(r.portfolio);
  const [lo, hi] = r.span("monthly");
  assert.ok(lo <= r.cases.typical.monthly && r.cases.typical.monthly <= hi);
  assert.ok(lo < hi);
});
