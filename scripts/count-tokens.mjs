// Counts tokens in the sample texts (data/samples) and compares them with the use-case defaults.
//
//   node scripts/count-tokens.mjs                 → estimate (characters ÷ 4), no network
//   GEMINI_API_KEY=... node scripts/count-tokens.mjs  → measured with Google's countTokens endpoint
//
// countTokens is free and does not run the model. The key is read from the environment, sent only
// to Google, and never stored. Results go to data/token-measurements.json, which the assumption
// register reads ("verified" when measured, "estimate" otherwise).
import { readFileSync, writeFileSync } from "node:fs";

const MODEL = "gemini-2.5-flash";
const SAMPLES = [
  { file: "chatbot_request.txt", useCase: "chatbot", field: "in_tokens", label: "Chatbot request (system prompt, 3 knowledge-base excerpts, history, question)" },
  { file: "invoice_2_pages.txt", useCase: "invoice_processing", field: "in_tokens_per_step", label: "Invoice extraction step (instructions + 2-page OCR text)" },
  { file: "ticket.txt", useCase: "ticket_triage", field: "in_tokens_per_step", label: "Ticket triage step (instructions + one email ticket)" },
  { file: "report_step.txt", useCase: "report_generation", field: "in_tokens_per_step", label: "Report step (instructions + one month of weekly sales data)" },
];

const root = new URL("../", import.meta.url);
const usecases = JSON.parse(readFileSync(new URL("data/usecases.json", root), "utf8"));
const key = process.env.GEMINI_API_KEY;

async function countWithGemini(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
  });
  if (!res.ok) throw new Error(`countTokens failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).totalTokens;
}

const results = [];
for (const s of SAMPLES) {
  const text = readFileSync(new URL(`data/samples/${s.file}`, root), "utf8");
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const tokens = key ? await countWithGemini(text) : Math.round(chars / 4);
  const current = usecases.usecases[s.useCase][s.field];
  results.push({ ...s, chars, words, tokens, method: key ? `measured: ${MODEL} countTokens` : "estimate: characters ÷ 4", current_default: current, ratio_to_default: Math.round((tokens / current) * 100) / 100 });
}

const out = {
  notes: "Token counts of representative sample texts (data/samples). 'measured' = Google's countTokens for the model named; 'estimate' = characters ÷ 4, a common rule of thumb for English text. Defaults in usecases.json are compared, not overwritten.",
  measured: !!key,
  method: key ? `${MODEL} countTokens` : "characters ÷ 4 (estimate)",
  date: new Date().toISOString().slice(0, 10),
  samples: results,
};
writeFileSync(new URL("data/token-measurements.json", root), JSON.stringify(out, null, 2) + "\n");
for (const r of results) console.log(`${r.file.padEnd(22)} ${String(r.tokens).padStart(6)} tokens (${r.method}); default ${r.current_default} → ×${r.ratio_to_default}`);
if (!key) console.log("\nSet GEMINI_API_KEY to measure with Google's countTokens instead of estimating.");
