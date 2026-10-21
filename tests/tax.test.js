import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { taxProfile, applyTax } from "../engine/tax.js";
import { withDefaults } from "../engine/inputs.js";
import { monthlyCosts } from "../engine/costs.js";
import { indexPrices } from "../engine/prices.js";
import { TEST_PRICE_ENTRIES, TEST_FX, TEST_SELFHOST } from "./fixtures.js";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url)));
const taxes = load("taxes.json");
const regions = load("regions.json");
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

test("taxes.json: every region has a valid default variant and sourced components", () => {
  for (const r of regions.regions) {
    const t = taxes.regions[r.code];
    assert.ok(t, `tax entry for ${r.code}`);
    assert.ok(t.variants.some((v) => v.id === t.default_variant), `${r.code} default variant`);
    for (const v of t.variants) {
      for (const c of v.components) {
        assert.ok(c.rate_pct === null || (c.rate_pct >= 0 && c.rate_pct <= 100), `${v.id} ${c.name} rate`);
        assert.equal(typeof c.recoverable, "boolean");
        assert.equal(typeof c.is_sample, "boolean");
        assert.ok(c.source_url, `${v.id} source`);
        assert.ok(isDate(c.last_verified), `${v.id} date`);
      }
    }
  }
});

test("VAT is reclaimable for registered businesses, a cost otherwise", () => {
  assert.equal(taxProfile(withDefaults({ region: "DE", taxRegistered: true }), taxes).nonRecoverablePct, 0);
  assert.equal(taxProfile(withDefaults({ region: "DE", taxRegistered: false }), taxes).nonRecoverablePct, 19);
  assert.equal(taxProfile(withDefaults({ region: "FI", taxRegistered: false }), taxes).nonRecoverablePct, 25.5);
});

test("Canada: provincial sales tax is never reclaimable; GST and QST are", () => {
  assert.equal(taxProfile(withDefaults({ region: "CA", taxVariant: "CA-BC", taxRegistered: true }), taxes).nonRecoverablePct, 7);
  assert.equal(taxProfile(withDefaults({ region: "CA", taxVariant: "CA-QC", taxRegistered: true }), taxes).nonRecoverablePct, 0);
  assert.ok(Math.abs(taxProfile(withDefaults({ region: "CA", taxVariant: "CA-QC", taxRegistered: false }), taxes).nonRecoverablePct - 14.975) < 1e-9);
  assert.equal(taxProfile(withDefaults({ region: "CA", taxVariant: "CA-ON", taxRegistered: false }), taxes).nonRecoverablePct, 13);
});

test("US: state sales tax uses the custom rate and is never reclaimable", () => {
  assert.equal(taxProfile(withDefaults({ region: "US", taxVariant: "US-none" }), taxes).nonRecoverablePct, 0);
  assert.equal(taxProfile(withDefaults({ region: "US", taxVariant: "US-custom", customTaxPct: 8.875, taxRegistered: true }), taxes).nonRecoverablePct, 8.875);
});

test("unknown variant falls back to the region default", () => {
  assert.equal(taxProfile(withDefaults({ region: "GB", taxVariant: "CA-ON", taxRegistered: false }), taxes).nonRecoverablePct, 20);
});

test("tax applies to vendor spend, not to labour", () => {
  const r = applyTax({ total: 300, lines: [{ label: "API", usd: 100 }, { label: "Maintenance labour", usd: 200, labour: true }] }, { nonRecoverablePct: 10, components: [{ name: "VAT", counted: true }] });
  assert.equal(r.taxMonthly, 10);
  assert.equal(r.total, 310);
});

test("monthly costs include non-reclaimable tax on every option", () => {
  const prices = indexPrices({ entries: TEST_PRICE_ENTRIES }, TEST_FX, TEST_SELFHOST, taxes);
  const base = withDefaults({ region: "GB", growthPct: 0 });
  const reg = monthlyCosts({ ...base, taxRegistered: true }, prices);
  const exempt = monthlyCosts({ ...base, taxRegistered: false }, prices);
  for (const id of ["B", "C", "D"]) {
    const labour = reg[id].lines.filter((l) => l.labour).reduce((s, l) => s + l.usd, 0);
    assert.ok(Math.abs(exempt[id].total - (reg[id].total + 0.2 * (reg[id].total - labour))) < 1e-6, id);
  }
});
