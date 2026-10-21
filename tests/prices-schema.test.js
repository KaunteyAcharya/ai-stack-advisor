import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { indexPrices } from "../engine/prices.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const prices = load("prices.json");
const fx = load("fx.json");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const CURRENCIES = ["USD", "INR", "EUR", "GBP", "CHF", "CAD", "AUD", "AED"];

test("every price entry has the required fields", () => {
  const ids = new Set();
  for (const p of prices.entries) {
    for (const f of ["id", "category", "unit", "source_url"]) assert.ok(p[f], `${p.id}: ${f}`);
    assert.ok(isDate(p.last_verified), `${p.id}: last_verified`);
    assert.equal(typeof p.is_sample, "boolean", `${p.id}: is_sample`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
  }
});

test("non-sample prices link to a real https source", () => {
  for (const p of prices.entries.filter((x) => !x.is_sample)) assert.match(p.source_url, /^https:\/\//, p.id);
});

test("all categories the engine needs are present", () => {
  const idx = indexPrices(prices, fx);
  for (const q of ["basic", "good", "best_available"]) assert.ok(idx.llm[q], q);
  for (const c of ["l4", "a100_80gb"]) {
    assert.ok(idx.gpu[c], c);
    assert.ok(idx.throughput[c], c);
  }
  for (const k of ["managedDb", "selfManagedDb", "vectorDb", "hosting", "storage", "monitoring", "stt", "tts"]) assert.ok(idx[k], k);
  assert.ok(idx.telephony.default);
  for (const tier of ["lite", "fast", "standard"]) assert.ok(idx.video[tier], `video ${tier}`);
  for (const k of ["image", "socialX", "marketData"]) assert.ok(idx[k], k);
  for (const q of ["basic", "good", "best_available"]) assert.ok(idx.llm[q].batch_input_price > 0, `${q} batch price`);
  const zap = idx.saasTiers.find((p) => p.pricing_type === "per_task");
  assert.ok(zap.task_tiers.every((t, i, a) => i === 0 || (t.tasks > a[i - 1].tasks && t.annual >= a[i - 1].annual)), "task tiers ascend");
  assert.ok(idx.saasTiers.length > 0);
});

test("scenario 11: fx.json schema", () => {
  assert.equal(fx.base, "USD");
  assert.ok(isDate(fx.as_of));
  assert.match(fx.source_url, /^https:\/\//);
  for (const c of CURRENCIES) assert.ok(fx.rates[c] > 0, c);
  assert.equal(fx.rates.AED, 3.6725);
});
