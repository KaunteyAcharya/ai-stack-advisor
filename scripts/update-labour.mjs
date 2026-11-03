// Refreshes the labour costs in data/labour.json and data/regions.json from official statistics with open APIs:
// Eurostat hourly labour cost levels (lc_lci_lev) for the euro-area countries, and BLS Employer Costs for
// Employee Compensation for the US. Also recalculates USD figures when the exchange rate has moved more than 2%.
// Other countries have no stable API; they are listed for a manual check.
// Usage: node scripts/update-labour.mjs [--out report.md] [--dry-run]
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const LABOUR_PATH = new URL("../data/labour.json", import.meta.url);
const REGIONS_PATH = new URL("../data/regions.json", import.meta.url);
const FX_PATH = new URL("../data/fx.json", import.meta.url);
const EUROSTAT = (geos, since) =>
  `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/lc_lci_lev?unit=EUR&lcstruct=D1_D4_MD5&nace_r2=B-S_X_O&${geos.map((g) => `geo=${g}`).join("&")}&sinceTimePeriod=${since}`;
const BLS = "https://api.bls.gov/publicAPI/v1/timeseries/data/";
// Civilian workers, total compensation per hour worked: office and administrative support; professional and related.
export const BLS_SERIES = { staff: "CMU1010000220000D", engineer: "CMU1010000120000D" };
const MAX_AUTO_CHANGE = 0.25; // bigger moves are listed, not applied
const FX_DRIFT = 0.02;
const QUARTER_END = { Q01: "March", Q02: "June", Q03: "September", Q04: "December" };

const round2 = (n) => Math.round(n * 100) / 100;
const isEurostat = (r) => /lc_lci_lev/.test(r.staff?.source_url ?? "");

// JSON-stat 2.0 → { geo: { year, value } } with the latest year that has a value.
export function eurostatLatest(json) {
  const { id, size, dimension, value } = json;
  const strides = size.map((_, i) => size.slice(i + 1).reduce((a, b) => a * b, 1));
  const labels = Object.fromEntries(id.map((d) => [d, Object.fromEntries(Object.entries(dimension[d].category.index).map(([k, i]) => [i, k]))]));
  const out = {};
  for (const [k, v] of Object.entries(value ?? {})) {
    if (typeof v !== "number") continue;
    const at = Object.fromEntries(id.map((d, i) => [d, labels[d][Math.floor(Number(k) / strides[i]) % size[i]]]));
    if (!out[at.geo] || at.time > out[at.geo].year) out[at.geo] = { year: at.time, value: v };
  }
  return out;
}

// BLS API response → { seriesId: { value, period } } from the latest data point.
export function blsLatest(json) {
  if (json?.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS API: ${json?.message?.join(" ") || json?.status || "no response"}`);
  const out = {};
  for (const s of json.Results?.series ?? []) {
    const d = s.data?.find((x) => x.latest === "true") ?? s.data?.[0];
    if (d && QUARTER_END[d.period]) out[s.seriesID] = { value: Number(d.value), period: `${QUARTER_END[d.period]} ${d.year}` };
  }
  return out;
}

// Pure: returns updated copies plus what changed. eurostat / bls may be undefined when a source failed.
export function refreshLabour({ labour, regions, fx, eurostat, bls }) {
  labour = structuredClone(labour);
  regions = structuredClone(regions);
  const updated = [];
  const recalculated = [];
  const review = [];
  const manual = [];
  const maxYear = eurostat ? Object.values(eurostat).reduce((m, x) => (x.year > m ? x.year : m), "") : null;

  const set = (code, name, l, key, value, period) => {
    const fig = l[key];
    if (fig.value === value && fig.period === period) return false;
    if (Math.abs(value / fig.value - 1) > MAX_AUTO_CHANGE) {
      review.push(`${name} ${key}: ours ${fig.value} ${fig.currency} (${fig.period}); new figure ${value} (${period}), a change over ${MAX_AUTO_CHANGE * 100}%`);
      return false;
    }
    updated.push({ code, name, figure: key, from: fig.value, to: value, currency: fig.currency, period });
    fig.value = value;
    fig.period = period;
    return true;
  };

  for (const [code, l] of Object.entries(labour.regions)) {
    const region = regions.regions.find((r) => r.code === code);
    const name = region?.name ?? code;
    let changed = false;
    if (isEurostat(l)) {
      const x = eurostat?.[code];
      if (!eurostat) {
        // source failure is reported once by the caller
      } else if (!x) review.push(`${name}: Eurostat returned no labour cost figure`);
      else changed = set(code, name, l, "staff", x.value, x.year === maxYear ? x.year : `${x.year} (${maxYear} not yet released for ${name})`);
    } else if (code === "US") {
      for (const key of ["staff", "engineer"]) {
        const x = bls?.[BLS_SERIES[key]];
        if (bls && !x) review.push(`${name} ${key}: BLS returned no figure for ${BLS_SERIES[key]}`);
        else if (x && l[key]) changed = set(code, name, l, key, x.value, x.period) || changed;
      }
    } else {
      manual.push({ name, period: l.staff.period, url: l.staff.source_url, statistic: l.staff.statistic });
    }

    const rate = l.staff.currency === "USD" ? 1 : fx.rates[l.staff.currency];
    const drift = rate > 0 && Math.abs(rate / l.fx_rate_used - 1) > FX_DRIFT;
    if (!changed && !drift) continue;
    const local = round2(l.staff.value * l.multiplier.value);
    const usd = round2(local / rate);
    if (!changed) recalculated.push({ name, from: l.staff_loaded_usd, to: usd, rate, oldRate: l.fx_rate_used, currency: l.staff.currency });
    l.staff_loaded_local = local;
    l.staff_loaded_usd = usd;
    l.fx_rate_used = rate;
    if (region) {
      region.staff_hourly_usd = usd;
      if (l.engineer?.currency === "USD") region.engineer_hourly_usd = l.engineer.value;
    }
  }
  if (recalculated.length || updated.length) labour.fx_as_of = fx.as_of;
  return { labour, regions, updated, recalculated, review, manual };
}

export function labourReport({ updated, recalculated, review, manual }, { today, errors = [] }) {
  const lines = ["## Labour costs", "", `Checked Eurostat and BLS on ${today}: ${updated.length} figures updated, ${recalculated.length} recalculated at the current exchange rate, ${review.length + errors.length} need a look.`];
  if (updated.length) {
    lines.push("", "### Updated", "", "| Region | Figure | Was | Now | Period |", "| --- | --- | --- | --- | --- |");
    for (const u of updated) lines.push(`| ${u.name} | ${u.figure} hourly cost | ${u.from} ${u.currency} | ${u.to} ${u.currency} | ${u.period} |`);
  }
  if (recalculated.length) {
    lines.push("", "### Recalculated in USD", "", "| Region | Exchange rate (per USD) | Was | Now |", "| --- | --- | --- | --- |");
    for (const r of recalculated) lines.push(`| ${r.name} | ${r.oldRate} → ${r.rate} ${r.currency} | $${r.from} | $${r.to} |`);
  }
  if (review.length || errors.length) lines.push("", "### Needs a look", "", ...[...errors, ...review].map((x) => `- ${x}`));
  if (manual.length) {
    lines.push("", "### Not checked automatically", "", "These come from national releases without an open API. Check them when a new release is out:", "");
    for (const m of manual) lines.push(m.url ? `- ${m.name}: [${m.period}](${m.url})` : `- ${m.name}: sample value, no official source`);
  }
  return lines.join("\n") + "\n";
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const dryRun = args.includes("--dry-run");
  const today = new Date().toISOString().slice(0, 10);
  const labour = JSON.parse(readFileSync(LABOUR_PATH, "utf8"));
  const regions = JSON.parse(readFileSync(REGIONS_PATH, "utf8"));
  const fx = JSON.parse(readFileSync(FX_PATH, "utf8"));
  const errors = [];

  let eurostat;
  const geos = Object.entries(labour.regions).filter(([, l]) => isEurostat(l)).map(([c]) => c);
  try {
    eurostat = eurostatLatest(await getJson(EUROSTAT(geos, Number(today.slice(0, 4)) - 3)));
  } catch (err) {
    errors.push(`Eurostat: ${err.message}`);
  }
  let bls;
  try {
    const body = JSON.stringify({ seriesid: Object.values(BLS_SERIES) });
    bls = blsLatest(await getJson(BLS, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
  } catch (err) {
    errors.push(err.message.startsWith("BLS") ? err.message : `BLS: ${err.message}`);
  }

  const r = refreshLabour({ labour, regions, fx, eurostat, bls });
  const changed = r.updated.length + r.recalculated.length;
  if (changed && !dryRun) {
    writeFileSync(LABOUR_PATH, JSON.stringify(r.labour, null, 2) + "\n");
    writeFileSync(REGIONS_PATH, JSON.stringify(r.regions, null, 2) + "\n");
  }
  const report = labourReport(r, { today, errors });
  if (out) writeFileSync(out, report);
  else console.log(report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `updated=${changed}\nreview=${r.review.length + errors.length}\n`);
  console.error(`${changed} changed, ${r.review.length + errors.length} to look at${dryRun ? " (dry run: nothing written)" : ""}`);
}

if (process.argv[1]?.endsWith("update-labour.mjs")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
