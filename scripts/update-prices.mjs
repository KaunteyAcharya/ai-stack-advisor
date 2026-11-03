// Cross-checks the AI model prices in data/prices.json against two independent lists that track
// providers' price pages: OpenRouter (the price of the provider's own endpoint) and LiteLLM's model price file.
// When both lists agree with each other but not with us, the price is updated for a human to confirm
// against the official source_url in a pull request. Anything else that differs is listed for a manual look.
// Usage: node scripts/update-prices.mjs [--out report.md] [--dry-run]
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const PRICES_PATH = new URL("../data/prices.json", import.meta.url);
const OPENROUTER = (id) => `https://openrouter.ai/api/v1/models/${id}/endpoints`;
const LITELLM = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const HEADERS = { "User-Agent": "ai-stack-advisor price cross-check (github.com/KaunteyAcharya/ai-stack-advisor)" };
const TOLERANCE = 0.005; // rounding in the lists
const MAX_AUTO_CHANGE = 0.8; // bigger moves are listed, not applied
export const FIELDS = ["input_price", "output_price", "cached_input_price", "batch_input_price", "batch_output_price"];
// A price no list reports moves with the base price it is derived from.
const SCALES_WITH = { cached_input_price: "input_price", batch_input_price: "input_price", batch_output_price: "output_price" };
const FIELD_LABELS = { input_price: "input", output_price: "output", cached_input_price: "cached input", batch_input_price: "batch input", batch_output_price: "batch output" };

const round = (n) => Number(n.toPrecision(6));
const perMillion = (v) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? round(n * 1e6) : undefined;
};
const same = (a, b) => Math.abs(a - b) <= Math.max(1e-9, TOLERANCE * Math.max(Math.abs(a), Math.abs(b)));
const usd = (v) => (v === undefined ? "—" : `$${v}`);

// Prices of one provider endpoint (matched by tag), USD per million tokens. undefined if the tag is not listed.
export function openrouterPrices(json, tag) {
  const p = json?.data?.endpoints?.find((e) => e.tag === tag)?.pricing;
  if (!p) return undefined;
  return { input_price: perMillion(p.prompt), output_price: perMillion(p.completion), cached_input_price: perMillion(p.input_cache_read) };
}

export function litellmPrices(db, key) {
  const m = db?.[key];
  if (!m) return undefined;
  return {
    input_price: perMillion(m.input_cost_per_token),
    output_price: perMillion(m.output_cost_per_token),
    cached_input_price: perMillion(m.cache_read_input_token_cost),
    batch_input_price: perMillion(m.input_cost_per_token_batches),
    batch_output_price: perMillion(m.output_cost_per_token_batches),
  };
}

// Prices we would accept for each field today: the main price, plus the introductory price while it runs.
function accepted(entry, today) {
  const introActive = Boolean(entry.intro && today <= entry.intro.until);
  const out = {};
  for (const f of FIELDS) out[f] = [entry[f], introActive ? entry.intro[f] : undefined].filter((v) => v !== undefined);
  return { introActive, out };
}

// sources: { OpenRouter: prices | undefined, LiteLLM: prices | undefined }
// Returns { status: "ok" | "update" | "review", changes: { field: { from, to, how } }, notes: [] }.
export function compareEntry(entry, sources, today) {
  const named = Object.entries(sources).filter(([, s]) => s);
  if (!named.length) return { status: "review", changes: {}, notes: ["no source lists this model"] };
  const { introActive, out: ok } = accepted(entry, today);
  const changes = {};
  const notes = [];
  const confirmed = new Set();
  for (const f of FIELDS) {
    const seen = named.filter(([, s]) => s[f] !== undefined).map(([name, s]) => [name, s[f]]);
    if (!seen.length) continue;
    if (seen.every(([, v]) => ok[f].some((a) => same(a, v)))) {
      confirmed.add(f);
      continue;
    }
    const listed = seen.map(([name, v]) => `${name} ${usd(v)}`).join(", ");
    const agreed = seen.length >= 2 && seen.every(([, v]) => same(v, seen[0][1]));
    const to = seen[0][1];
    if (introActive) notes.push(`${FIELD_LABELS[f]}: ours ${usd(entry[f])} (introductory ${usd(entry.intro[f])} until ${entry.intro.until}); ${listed}`);
    else if (entry[f] === undefined) notes.push(`${FIELD_LABELS[f]}: we have no price; ${listed}`);
    else if (!agreed) notes.push(`${FIELD_LABELS[f]}: ours ${usd(entry[f])}; ${listed}${seen.length < 2 ? " (one source only)" : " (sources disagree)"}`);
    else if (Math.abs(to / entry[f] - 1) > MAX_AUTO_CHANGE) notes.push(`${FIELD_LABELS[f]}: ours ${usd(entry[f])}; ${listed} (change over ${MAX_AUTO_CHANGE * 100}%)`);
    else changes[f] = { from: entry[f], to, how: "both sources" };
  }
  if (notes.length) return { status: "review", changes: {}, notes };
  if (!Object.keys(changes).length) return { status: "ok", changes, notes };
  for (const [f, base] of Object.entries(SCALES_WITH)) {
    if (entry[f] === undefined || changes[f] || confirmed.has(f) || !changes[base]) continue;
    changes[f] = { from: entry[f], to: round((entry[f] * changes[base].to) / changes[base].from), how: `scaled with ${FIELD_LABELS[base]}` };
  }
  return { status: "update", changes, notes };
}

export function applyChanges(entry, changes, today) {
  const next = { ...entry };
  for (const [f, c] of Object.entries(changes)) next[f] = c.to;
  next.last_verified = today;
  return next;
}

export function pricesReport(results, { today, errors = [] }) {
  const by = (s) => results.filter((r) => r.status === s);
  const updated = by("update");
  const review = by("review");
  const lines = [
    "## AI model prices",
    "",
    `Cross-checked ${results.length} models against OpenRouter and LiteLLM on ${today}: ${by("ok").length} match, ${updated.length} updated, ${review.length} need a look.`,
  ];
  if (updated.length) {
    lines.push("", "### Updated", "", "| Model | Price per 1M tokens | Was | Now | Basis |", "| --- | --- | --- | --- | --- |");
    for (const r of updated) for (const [f, c] of Object.entries(r.changes)) lines.push(`| ${r.entry.label} | ${FIELD_LABELS[f]} | ${usd(c.from)} | ${usd(c.to)} | ${c.how} |`);
    lines.push("", "Before merging, open each model's price page and confirm the new prices; edit the notes text where it quotes the old ones:", "");
    for (const r of updated) lines.push(`- [${r.entry.label}](${r.entry.source_url})${quotesOld(r) ? " (notes quote the old price)" : ""}`);
  }
  if (review.length) {
    lines.push("", "### Needs a look", "", "Nothing was changed for these:", "");
    for (const r of review) lines.push(`- [${r.entry.label}](${r.entry.source_url}) \`${r.entry.id}\`: ${r.notes.join("; ")}`);
  }
  if (errors.length) lines.push("", "### Could not check", "", ...errors.map((e) => `- ${e}`));
  return lines.join("\n") + "\n";
}

const quotesOld = (r) => Object.values(r.changes).some((c) => [String(c.from), c.from.toFixed(2)].some((s) => r.entry.notes?.includes(`$${s} `) || r.entry.notes?.includes(`$${s}.`) || r.entry.notes?.includes(`$${s};`)));

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const args = process.argv.slice(2);
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  const dryRun = args.includes("--dry-run");
  const today = new Date().toISOString().slice(0, 10);
  const raw = JSON.parse(readFileSync(PRICES_PATH, "utf8"));
  const errors = [];
  let litellm;
  try {
    litellm = await getJson(LITELLM);
  } catch (err) {
    errors.push(`LiteLLM price list: ${err.message}`);
  }

  const results = [];
  for (const [i, entry] of raw.entries.entries()) {
    const cc = entry.cross_check;
    if (!cc) continue;
    let openrouter;
    try {
      openrouter = openrouterPrices(await getJson(OPENROUTER(cc.openrouter)), cc.openrouter_tag);
      if (!openrouter) errors.push(`${entry.label}: OpenRouter lists no \`${cc.openrouter_tag}\` endpoint for \`${cc.openrouter}\``);
    } catch (err) {
      errors.push(`${entry.label}: OpenRouter \`${cc.openrouter}\`: ${err.message}`);
    }
    const ll = cc.litellm ? litellmPrices(litellm, cc.litellm) : undefined;
    if (cc.litellm && litellm && !ll) errors.push(`${entry.label}: LiteLLM has no \`${cc.litellm}\``);
    const r = { entry, ...compareEntry(entry, { OpenRouter: openrouter, LiteLLM: ll }, today) };
    results.push(r);
    if (r.status === "update") raw.entries[i] = applyChanges(entry, r.changes, today);
  }

  const updated = results.filter((r) => r.status === "update").length;
  const review = results.filter((r) => r.status === "review").length + errors.length;
  if (updated && !dryRun) writeFileSync(PRICES_PATH, JSON.stringify(raw, null, 2) + "\n");
  const report = pricesReport(results, { today, errors });
  if (out) writeFileSync(out, report);
  else console.log(report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `updated=${updated}\nreview=${review}\n`);
  console.error(`${updated} updated, ${review} to look at${dryRun ? " (dry run: nothing written)" : ""}`);
}

if (process.argv[1]?.endsWith("update-prices.mjs")) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
