import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildRegister, fieldIndex, relevantEntries, confidenceCounts, sortForReview, factorConfidence, CONFIDENCE } from "../engine/register.js";
import { DEFAULT_INPUTS } from "../engine/inputs.js";
import { factorsFor } from "../engine/simulate.js";
import { withDefaults } from "../engine/inputs.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const data = {
  assumptions: load("assumptions.json"),
  prices: load("prices.json"),
  taxes: load("taxes.json"),
  fx: load("fx.json"),
  labour: load("labour.json"),
  tokens: load("token-measurements.json"),
  regions: load("regions.json"),
};
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

test("every register entry has a label, value, confidence, source and review date", () => {
  for (const region of data.regions.regions.map((r) => r.code)) {
    for (const e of buildRegister(data, region)) {
      assert.ok(e.label && e.value != null, e.id);
      assert.ok(CONFIDENCE.includes(e.confidence), `${e.id}: ${e.confidence}`);
      assert.ok(e.source != null, `${e.id} source`);
      assert.ok(isDate(e.last_reviewed), `${e.id} last_reviewed ${e.last_reviewed}`);
      if (e.confidence === "verified" && e.kind !== "assumption") assert.ok(e.source_url, `${e.id}: verified entries link to their source`);
    }
  }
});

test("register field keys are real inputs", () => {
  const nested = (k) => k.includes(".") && DEFAULT_INPUTS[k.split(".")[0]]?.[k.split(".")[1]] !== undefined;
  for (const e of data.assumptions.entries) for (const f of e.fields) assert.ok(f in DEFAULT_INPUTS || nested(f), `${e.id}: ${f}`);
});

test("staff and engineer costs come from the labour statistics", () => {
  const idx = fieldIndex(buildRegister(data, "DE"));
  assert.equal(idx.staffHourlyUsd.confidence, "benchmark");
  assert.match(idx.staffHourlyUsd.source, /Eurostat/);
  assert.equal(fieldIndex(buildRegister(data, "US")).engineerHourlyUsd.confidence, "benchmark");
  assert.equal(fieldIndex(buildRegister(data, "IN")).engineerHourlyUsd.confidence, "estimate");
  assert.equal(fieldIndex(buildRegister(data, "AE")).staffHourlyUsd.confidence, "estimate", "no official UAE statistic");
});

test("labour.json and regions.json agree (staff cost in USD)", () => {
  for (const r of data.regions.regions) {
    const l = data.labour.regions[r.code];
    assert.ok(l, r.code);
    const usd = l.staff_loaded_local / l.fx_rate_used;
    assert.ok(Math.abs(usd - r.staff_hourly_usd) < 0.01, `${r.code}: ${usd} vs ${r.staff_hourly_usd}`);
    assert.ok(Math.abs(l.staff.value * l.multiplier.value - l.staff_loaded_local) < 0.01, `${r.code} loaded = value × multiplier`);
    if (l.multiplier.confidence !== "estimate" && l.multiplier.value !== 1) assert.ok(l.multiplier.source_url, `${r.code} on-cost source`);
  }
});

test("token measurements cover the samples and compare with defaults", () => {
  const usecases = load("usecases.json");
  for (const s of data.tokens.samples) {
    assert.ok(s.tokens > 0 && s.chars > 0);
    assert.equal(s.current_default, usecases.usecases[s.useCase][s.field]);
    readFileSync(new URL(`../data/samples/${s.file}`, import.meta.url));
  }
});

test("relevant entries keep all assumptions but only the prices used", () => {
  const reg = buildRegister(data, "US");
  const rel = relevantEntries(reg, ["llm_mid_gemini_2_5_flash"]);
  assert.equal(rel.filter((e) => e.kind === "price").length, 1);
  assert.equal(rel.filter((e) => e.kind === "assumption").length, reg.filter((e) => e.kind === "assumption").length);
  const counts = confidenceCounts(rel);
  assert.equal(counts.verified + counts.benchmark + counts.estimate, rel.length);
  const sorted = sortForReview(rel);
  assert.equal(sorted[0].confidence, "estimate");
});

test("every simulation factor maps to a confidence", () => {
  const reg = buildRegister(data, "US");
  for (const f of factorsFor(withDefaults({ useCase: "invoice_processing" }))) assert.ok(CONFIDENCE.includes(factorConfidence(f.id, reg, ["llm_mid_gemini_2_5_flash", "gpu_l4_runpod"])), f.id);
  assert.equal(factorConfidence("llmPrice", reg, ["llm_mid_gemini_2_5_flash"]), "verified");
  assert.equal(factorConfidence("gpuPrice", reg, ["gpu_l4_runpod"]), "estimate", "RunPod rates are still samples");
});
