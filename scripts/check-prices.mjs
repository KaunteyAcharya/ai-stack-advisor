// Lists price entries that are older than N days or marked as samples.
// Usage: node scripts/check-prices.mjs --max-age-days 30 [--today YYYY-MM-DD] [--out report.md]
// Exit code is 0 either way; the workflow reads the "count" line / report file.
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const maxAge = Number(arg("--max-age-days", 30));
const today = arg("--today", new Date().toISOString().slice(0, 10));
const out = arg("--out", null);

const prices = JSON.parse(readFileSync(new URL("../data/prices.json", import.meta.url)));
const taxes = JSON.parse(readFileSync(new URL("../data/taxes.json", import.meta.url)));
const ageDays = (d) => Math.floor((Date.parse(today) - Date.parse(d)) / 86_400_000);

// Tax components with a fixed rate are checked the same way as prices.
const taxEntries = Object.entries(taxes.regions).flatMap(([region, t]) =>
  t.variants.flatMap((v) =>
    v.components.filter((c) => c.rate_pct != null).map((c) => ({ ...c, id: `tax:${v.id}:${c.name}`, label: `${v.label} (${region})` })),
  ),
);
const unique = [...new Map(taxEntries.map((t) => [`${t.name}|${t.source_url}|${t.label}`, t])).values()];

const flagged = [...prices.entries, ...unique]
  .map((p) => ({ ...p, age: ageDays(p.last_verified) }))
  .filter((p) => p.is_sample || !(p.age <= maxAge));

const lines = [
  `Checked ${prices.entries.length} price entries and ${unique.length} tax rates on ${today} (max age ${maxAge} days).`,
  "",
  ...flagged.map((p) => {
    const why = [p.is_sample ? "sample value" : null, p.age > maxAge ? `last verified ${p.last_verified} (${p.age} days ago)` : null].filter(Boolean).join("; ");
    return `- [ ] \`${p.id}\` — ${p.label}: ${why}. Source: ${p.source_url}`;
  }),
];
const report = flagged.length ? lines.join("\n") : `All ${prices.entries.length} price entries are verified within ${maxAge} days.`;

console.log(report);
console.log(`\ncount=${flagged.length}`);
if (out) writeFileSync(out, report + "\n");
if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `count=${flagged.length}\n`, { flag: "a" });
