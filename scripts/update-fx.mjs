// Downloads the ECB euro reference rates and writes data/fx.json with a USD base.
// rate_X_per_USD = EUR_X / EUR_USD. AED comes from its fixed USD peg (3.6725).
// Fails (exit 1) if a currency is missing, a rate is not positive, or any rate moved > 15%.
import { readFileSync, writeFileSync } from "node:fs";

const ECB_XML = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const TARGETS = ["INR", "GBP", "CHF", "CAD", "AUD"];
const AED_PEG = 3.6725;
const MAX_CHANGE = 0.15;
const FX_PATH = new URL("../data/fx.json", import.meta.url);

export function parseEcb(xml) {
  const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
  const eur = {};
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) eur[m[1]] = Number(m[2]);
  return { date, eur };
}

export function toUsdBase(eur) {
  if (!(eur.USD > 0)) throw new Error("ECB data has no USD rate");
  const rates = { USD: 1 };
  for (const c of TARGETS) {
    if (!(eur[c] > 0)) throw new Error(`ECB data missing or invalid rate for ${c}`);
    rates[c] = Number((eur[c] / eur.USD).toFixed(6));
  }
  rates.EUR = Number((1 / eur.USD).toFixed(6));
  rates.AED = AED_PEG;
  return { USD: 1, INR: rates.INR, EUR: rates.EUR, GBP: rates.GBP, CHF: rates.CHF, CAD: rates.CAD, AUD: rates.AUD, AED: rates.AED };
}

export function checkChanges(oldRates, newRates, maxChange = MAX_CHANGE) {
  const problems = [];
  for (const [c, v] of Object.entries(newRates)) {
    if (!(v > 0)) problems.push(`${c} is not positive`);
    const old = oldRates?.[c];
    if (old > 0 && Math.abs(v - old) / old > maxChange) problems.push(`${c} moved ${((100 * (v - old)) / old).toFixed(1)}% (${old} → ${v})`);
  }
  return problems;
}

async function main() {
  const res = await fetch(ECB_XML);
  if (!res.ok) throw new Error(`ECB download failed: HTTP ${res.status}`);
  const { date, eur } = parseEcb(await res.text());
  if (!date) throw new Error("Could not read the ECB reference date");
  const rates = toUsdBase(eur);
  const current = JSON.parse(readFileSync(FX_PATH));
  const problems = checkChanges(current.is_sample ? null : current.rates, rates);
  if (problems.length) throw new Error(`Rate validation failed:\n- ${problems.join("\n- ")}`);

  const next = {
    base: "USD",
    as_of: date,
    source: "European Central Bank euro foreign exchange reference rates",
    source_url: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
    rates,
    is_sample: false,
    notes: "Reference rates for planning only. Converted from EUR base (rate_X_per_USD = EUR_X / EUR_USD). AED derived from its fixed USD peg (3.6725).",
  };
  writeFileSync(FX_PATH, JSON.stringify(next, null, 2) + "\n");
  console.log(`fx.json updated to ${date}`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("update-fx.mjs")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
