import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateInputs } from "../engine/validate.js";
import { withDefaults } from "../engine/inputs.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const presets = load("presets.json");
const regions = load("regions.json");

test("errors: negative numbers, bad percentages, zero users", () => {
  const { errors } = validateInputs(withDefaults({ usersPerDay: 0, seats: -1, marginPct: 120 }));
  const fields = errors.map((e) => e.field);
  assert.ok(fields.includes("usersPerDay"));
  assert.ok(fields.includes("seats"));
  assert.ok(fields.includes("marginPct"));
});

test("defaults are valid", () => {
  assert.equal(validateInputs(withDefaults()).errors.length, 0);
});

test("scenario 6: real estate ticket of ₹65 → 'Did you mean lakh?'", () => {
  const inputs = withDefaults({ industry: "real_estate", displayCurrency: "INR", ticketUsd: 65 / 95 });
  const { warnings } = validateInputs(inputs, { presets, regions });
  assert.ok(warnings.some((w) => w.message.includes("Did you mean lakh?")));
});

test("small ticket in other currencies suggests k / M", () => {
  const inputs = withDefaults({ industry: "real_estate", region: "DE", displayCurrency: "EUR", ticketUsd: 65 });
  const { warnings } = validateInputs(inputs, { presets, regions });
  assert.ok(warnings.some((w) => w.message.includes("thousands (k) or millions (M)")));
});

test("display currency differs from country currency → info", () => {
  const { warnings } = validateInputs(withDefaults({ region: "AE", displayCurrency: "EUR" }), { regions });
  assert.ok(warnings.some((w) => w.message === "Results shown in EUR for a company in the UAE."));
});

test("stale FX, high conversion, high growth, many requests", () => {
  const { warnings } = validateInputs(withDefaults({ conversionPct: 60, growthPct: 40, requestsPerUser: 150 }), {
    fx: { as_of: "2026-01-01" },
    today: "2026-02-01",
  });
  const fields = warnings.map((w) => w.field);
  for (const f of ["fx", "conversionPct", "growthPct", "requestsPerUser"]) assert.ok(fields.includes(f), f);
});

test("docs/inputs.schema.json covers every input field", async () => {
  const { DEFAULT_INPUTS } = await import("../engine/inputs.js");
  const schema = JSON.parse(readFileSync(new URL("../docs/inputs.schema.json", import.meta.url)));
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(DEFAULT_INPUTS).sort());
});
