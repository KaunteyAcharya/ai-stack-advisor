import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openrouterPrices, litellmPrices, compareEntry, applyChanges, pricesReport } from "../scripts/update-prices.mjs";
import { eurostatLatest, blsLatest, refreshLabour, labourReport, BLS_SERIES } from "../scripts/update-labour.mjs";

const load = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const TODAY = "2026-11-03";
const entry = (o = {}) => ({ id: "m", label: "Model", source_url: "https://example.com/pricing", last_verified: "2026-10-01", input_price: 1, output_price: 4, cached_input_price: 0.1, batch_input_price: 0.5, batch_output_price: 2, ...o });
const src = (o) => ({ input_price: 1, output_price: 4, ...o });

test("OpenRouter endpoint prices: picks the provider's tag and converts per token to per million", () => {
  const json = { data: { endpoints: [
    { tag: "other", pricing: { prompt: "0.000009", completion: "0.000009" } },
    { tag: "mistral", pricing: { prompt: "0.0000005", completion: "0.0000015", input_cache_read: "0.00000005" } },
    { tag: "variable", pricing: { prompt: "-1", completion: "0" } },
  ] } };
  assert.deepEqual(openrouterPrices(json, "mistral"), { input_price: 0.5, output_price: 1.5, cached_input_price: 0.05 });
  assert.equal(openrouterPrices(json, "missing"), undefined);
  assert.equal(openrouterPrices(json, "variable").input_price, undefined, "negative means no fixed price");
});

test("LiteLLM prices include batch and cache-read prices", () => {
  const db = { k: { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5, cache_read_input_token_cost: 3e-7, input_cost_per_token_batches: 1.5e-6, output_cost_per_token_batches: 7.5e-6 } };
  assert.deepEqual(litellmPrices(db, "k"), { input_price: 3, output_price: 15, cached_input_price: 0.3, batch_input_price: 1.5, batch_output_price: 7.5 });
  assert.equal(litellmPrices(db, "nope"), undefined);
});

test("matching prices (within rounding) need nothing", () => {
  const r = compareEntry(entry(), { OpenRouter: src({ input_price: 1.004, cached_input_price: 0.1 }), LiteLLM: src({ batch_input_price: 0.5 }) }, TODAY);
  assert.equal(r.status, "ok");
});

test("both sources agreeing on a new price → update, with unreported derived prices scaled", () => {
  const r = compareEntry(entry(), { OpenRouter: src({ input_price: 1.2 }), LiteLLM: src({ input_price: 1.2 }) }, TODAY);
  assert.equal(r.status, "update");
  assert.deepEqual(r.changes.input_price, { from: 1, to: 1.2, how: "both sources" });
  assert.equal(r.changes.batch_input_price.to, 0.6);
  assert.equal(r.changes.cached_input_price.to, 0.12);
  assert.equal(r.changes.output_price, undefined);
  assert.equal(r.changes.batch_output_price, undefined, "output did not move");
  const next = applyChanges(entry(), r.changes, TODAY);
  assert.equal(next.input_price, 1.2);
  assert.equal(next.last_verified, TODAY);
  assert.match(pricesReport([{ entry: entry(), ...r }], { today: TODAY }), /\| Model \| input \| \$1 \| \$1\.2 \| both sources \|/);
});

test("a derived price a source confirms is not scaled", () => {
  const r = compareEntry(entry(), { OpenRouter: src({ input_price: 1.2, cached_input_price: 0.1 }), LiteLLM: src({ input_price: 1.2 }) }, TODAY);
  assert.equal(r.changes.cached_input_price, undefined);
});

test("disagreement, a single source, a huge change or a missing price of ours → listed, nothing changed", () => {
  const cases = [
    [{ OpenRouter: src({ input_price: 1.2 }), LiteLLM: src({ input_price: 1.3 }) }, /sources disagree/],
    [{ OpenRouter: src({ input_price: 1.2 }), LiteLLM: undefined }, /one source only/],
    [{ OpenRouter: src({ output_price: 9 }), LiteLLM: src({ output_price: 9 }) }, /change over 80%/],
    [{ OpenRouter: src(), LiteLLM: src({ batch_output_price: 1 }) }, /one source only/],
  ];
  for (const [sources, why] of cases) {
    const r = compareEntry(entry(), sources, TODAY);
    assert.equal(r.status, "review");
    assert.deepEqual(r.changes, {});
    assert.match(r.notes.join(" "), why);
  }
  const noBatch = compareEntry(entry({ batch_input_price: undefined }), { OpenRouter: src(), LiteLLM: src({ batch_input_price: 0.5 }) }, TODAY);
  assert.match(noBatch.notes.join(" "), /we have no price/);
  assert.equal(compareEntry(entry(), { OpenRouter: undefined, LiteLLM: undefined }, TODAY).status, "review");
});

test("introductory prices are accepted while they run; any other difference is left for a person", () => {
  const e = entry({ input_price: 2, output_price: 8, intro: { until: "2026-12-31", input_price: 1, output_price: 4 } });
  assert.equal(compareEntry(e, { OpenRouter: src(), LiteLLM: src() }, TODAY).status, "ok");
  assert.equal(compareEntry(e, { OpenRouter: src({ input_price: 2, output_price: 8 }), LiteLLM: src({ input_price: 2, output_price: 8 }) }, TODAY).status, "ok");
  const r = compareEntry(e, { OpenRouter: src({ input_price: 1.5 }), LiteLLM: src({ input_price: 1.5 }) }, TODAY);
  assert.equal(r.status, "review");
  assert.match(r.notes[0], /introductory/);
  assert.equal(compareEntry(e, { OpenRouter: src(), LiteLLM: src() }, "2027-01-01").status, "update", "after the intro ends, the intro price no longer matches");
});

// Shape of a real lc_lci_lev response (DE, NL, BE × 2023–2025), Belgium without 2025.
const JSONSTAT = {
  id: ["freq", "unit", "lcstruct", "nace_r2", "geo", "time"],
  size: [1, 1, 1, 1, 3, 3],
  value: { 0: 41.4, 1: 43.5, 2: 45, 3: 42.9, 4: 45.2, 5: 47.9, 6: 47, 7: 48.2 },
  dimension: {
    freq: { category: { index: { A: 0 } } },
    unit: { category: { index: { EUR: 0 } } },
    lcstruct: { category: { index: { D1_D4_MD5: 0 } } },
    nace_r2: { category: { index: { "B-S_X_O": 0 } } },
    geo: { category: { index: { DE: 0, NL: 1, BE: 2 } } },
    time: { category: { index: { 2023: 0, 2024: 1, 2025: 2 } } },
  },
};

test("Eurostat JSON-stat → latest year per country", () => {
  assert.deepEqual(eurostatLatest(JSONSTAT), { DE: { year: "2025", value: 45 }, NL: { year: "2025", value: 47.9 }, BE: { year: "2024", value: 48.2 } });
});

const BLS_OK = {
  status: "REQUEST_SUCCEEDED",
  Results: { series: [
    { seriesID: BLS_SERIES.staff, data: [{ year: "2026", period: "Q03", latest: "true", value: "38.90" }, { year: "2026", period: "Q02", value: "38.27" }] },
    { seriesID: BLS_SERIES.engineer, data: [{ year: "2026", period: "Q03", latest: "true", value: "75.10" }] },
  ] },
};

test("BLS → latest quarter, named by the quarter's last month; API refusals throw", () => {
  assert.deepEqual(blsLatest(BLS_OK)[BLS_SERIES.staff], { value: 38.9, period: "September 2026" });
  assert.throws(() => blsLatest({ status: "REQUEST_NOT_PROCESSED", message: ["daily threshold reached"] }), /threshold/);
});

const current = () => ({ labour: load("labour.json"), regions: load("regions.json"), fx: load("fx.json") });
const eurostatNow = (labour) => Object.fromEntries(Object.entries(labour.regions).filter(([, l]) => /lc_lci_lev/.test(l.staff.source_url ?? "")).map(([c, l]) => [c, { year: l.staff.period.slice(0, 4), value: l.staff.value }]));
const blsNow = (labour) => ({ [BLS_SERIES.staff]: { value: labour.regions.US.staff.value, period: labour.regions.US.staff.period }, [BLS_SERIES.engineer]: { value: labour.regions.US.engineer.value, period: labour.regions.US.engineer.period } });

test("labour: today's figures change nothing; new figures update labour.json and regions.json together", () => {
  const { labour, regions, fx } = current();
  const same = refreshLabour({ labour, regions, fx, eurostat: eurostatNow(labour), bls: blsNow(labour) });
  assert.equal(same.updated.length + same.recalculated.length + same.review.length, 0);
  assert.deepEqual(same.labour, labour);

  const r = refreshLabour({ labour, regions, fx, eurostat: { ...eurostatNow(labour), DE: { year: "2026", value: 46.5 } }, bls: blsLatest(BLS_OK) });
  const de = r.labour.regions.DE;
  assert.equal(de.staff.value, 46.5);
  assert.equal(de.staff.period, "2026");
  assert.equal(de.staff_loaded_usd, Math.round((46.5 / fx.rates.EUR) * 100) / 100);
  assert.equal(r.regions.regions.find((x) => x.code === "DE").staff_hourly_usd, de.staff_loaded_usd);
  assert.match(r.labour.regions.NL.staff.period, /2026 not yet released for Netherlands/);
  const us = r.regions.regions.find((x) => x.code === "US");
  assert.equal(us.staff_hourly_usd, 38.9);
  assert.equal(us.engineer_hourly_usd, 75.1);
  assert.equal(r.labour.regions.US.engineer.period, "September 2026");
  assert.equal(labour.regions.DE.staff.value, 45, "input not mutated");
  assert.match(labourReport(r, { today: TODAY }), /Germany \| staff hourly cost \| 45 EUR \| 46\.5 EUR \| 2026/);
});

test("labour: a change over 25% is listed, not applied; a 3% exchange-rate move recalculates USD", () => {
  const { labour, regions, fx } = current();
  const big = refreshLabour({ labour, regions, fx, eurostat: { ...eurostatNow(labour), FI: { year: "2025", value: 60 } } });
  assert.equal(big.labour.regions.FI.staff.value, labour.regions.FI.staff.value);
  assert.match(big.review[0], /Finland/);

  const moved = { ...fx, as_of: "2026-11-02", rates: { ...fx.rates, INR: fx.rates.INR * 1.03 } };
  const r = refreshLabour({ labour, regions, fx: moved });
  assert.deepEqual(r.recalculated.map((x) => x.name), ["India"]);
  assert.equal(r.labour.regions.IN.staff_loaded_usd, Math.round((labour.regions.IN.staff_loaded_local / moved.rates.INR) * 100) / 100);
  assert.equal(r.labour.fx_as_of, "2026-11-02");
  assert.ok(r.manual.some((m) => m.name === "India"));
});

test("data files are written in the same format the scripts use, so a refresh only shows real changes", () => {
  for (const f of ["prices.json", "labour.json", "regions.json"]) {
    const text = readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8");
    assert.equal(JSON.stringify(JSON.parse(text), null, 2) + "\n", text, f);
  }
  for (const e of load("prices.json").entries.filter((x) => x.cross_check)) assert.ok(e.cross_check.openrouter_tag, `${e.id} OpenRouter tag`);
});
