// Assumption register: one list of every number the result rests on, with its source, a
// confidence level and the date it was last reviewed.
//   verified  = taken from an official or primary source (vendor price page, tax authority, ECB…)
//   benchmark = an official statistic or published reference used as a proxy (e.g. average wages)
//   estimate  = a reasoned judgement or sample value, to replace with your own figure

export const CONFIDENCE = ["verified", "benchmark", "estimate"];
const RANK = { estimate: 0, benchmark: 1, verified: 2 };

const priceConfidence = (p) => (p.category === "gpu_throughput" || p.is_sample || !/^https:\/\//.test(p.source_url || "") ? "estimate" : "verified");

/**
 * @param data   { assumptions, prices (raw prices.json), taxes, fx, labour, tokens, regions }
 * @param region region code (labour and tax entries are region-specific)
 */
export function buildRegister(data, region) {
  const out = data.assumptions.entries.map((e) => ({ ...e, kind: "assumption" }));

  // Token samples: measured with the provider's counter, or estimated.
  if (data.tokens) {
    const t = data.tokens;
    out.push({
      id: "token_samples",
      kind: "assumption",
      label: "Token counts of sample texts",
      value: t.samples.map((s) => `${s.useCase.replace(/_/g, " ")} ${s.tokens.toLocaleString("en-US")} (default ${s.current_default.toLocaleString("en-US")})`).join("; "),
      confidence: t.measured ? "verified" : "estimate",
      source: t.measured ? `Measured with ${t.method} on data/samples` : "Characters ÷ 4 on data/samples; run npm run count-tokens with a Gemini API key to measure",
      source_url: t.measured ? "https://ai.google.dev/api/tokens" : null,
      last_reviewed: t.date,
      fields: [],
    });
  }

  // Labour: staff and engineer hourly costs for this region.
  const lab = data.labour?.regions?.[region];
  const reg = data.regions?.regions?.find((r) => r.code === region);
  if (lab) {
    const conf = lab.staff.confidence === "estimate" || lab.multiplier.confidence === "estimate" ? (lab.staff.confidence === "estimate" ? "estimate" : "benchmark") : lab.staff.confidence;
    out.push({
      id: "staff_hourly",
      kind: "labour",
      label: "Hourly cost of the person doing the work today",
      value: `${lab.staff_loaded_local.toLocaleString("en-US")} ${lab.staff.currency}/hour fully loaded${lab.multiplier.value !== 1 ? ` (${lab.staff.value.toFixed(2)} × ${lab.multiplier.value.toFixed(3)} on-costs)` : ""}`,
      confidence: conf,
      source: `${lab.staff.statistic}${lab.staff.period ? `, ${lab.staff.period}` : ""}. On-costs: ${lab.multiplier.basis}`,
      source_url: lab.staff.source_url,
      last_reviewed: data.labour.last_reviewed,
      fields: ["staffHourlyUsd"],
    });
  }
  if (reg) {
    out.push({
      id: "engineer_hourly",
      kind: "labour",
      label: "Engineer hourly cost",
      value: `USD ${reg.engineer_hourly_usd}/hour`,
      confidence: lab?.engineer ? lab.engineer.confidence : "estimate",
      source: lab?.engineer ? `${lab.engineer.statistic}, ${lab.engineer.period}` : "Sample value for the region; replace with your team's or contractor's rate",
      source_url: lab?.engineer?.source_url ?? null,
      last_reviewed: data.labour?.last_reviewed ?? null,
      fields: ["engineerHourlyUsd"],
    });
  }

  // Exchange rates.
  if (data.fx) {
    out.push({ id: "fx", kind: "fx", label: "Exchange rates", value: `ECB reference rates of ${data.fx.as_of}; AED from its 3.6725 USD peg`, confidence: data.fx.is_sample ? "estimate" : "verified", source: data.fx.source, source_url: data.fx.source_url, last_reviewed: data.fx.as_of, fields: [] });
  }

  // Tax rates for this region.
  for (const v of data.taxes?.regions?.[region]?.variants || []) {
    for (const c of v.components) {
      if (c.rate_pct == null) continue;
      out.push({ id: `tax:${v.id}:${c.name}`, kind: "tax", label: `Tax: ${v.label}`, value: c.name, confidence: c.is_sample ? "estimate" : "verified", source: c.notes || "Tax authority", source_url: /^https:/.test(c.source_url) ? c.source_url : null, last_reviewed: c.last_verified, fields: [] });
    }
  }

  // Vendor prices (and GPU throughput assumptions).
  for (const p of data.prices?.entries || []) {
    out.push({ id: `price:${p.id}`, kind: "price", priceId: p.id, label: p.label, value: p.unit, confidence: priceConfidence(p), source: p.notes || "", source_url: /^https:/.test(p.source_url || "") ? p.source_url : null, last_reviewed: p.last_verified, fields: [] });
  }
  return out;
}

/** Field key → register entry, for showing confidence next to inputs. */
export function fieldIndex(register) {
  const map = {};
  for (const e of register) for (const f of e.fields || []) map[f] = e;
  return map;
}

/** Entries relevant to one result: all non-price entries, plus only the prices it used. */
export function relevantEntries(register, usedPriceIds = []) {
  const used = new Set(usedPriceIds);
  return register.filter((e) => e.kind !== "price" || used.has(e.priceId));
}

export function confidenceCounts(entries) {
  const c = { verified: 0, benchmark: 0, estimate: 0 };
  for (const e of entries) c[e.confidence] = (c[e.confidence] || 0) + 1;
  return c;
}

/** Sorted for display: estimates first (they need attention), then benchmarks, then verified. */
export function sortForReview(entries) {
  return [...entries].sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || a.label.localeCompare(b.label));
}

/** Confidence of a simulation / tornado factor (engine assumption or input). */
export function factorConfidence(factorId, register, usedPriceIds = []) {
  const byId = Object.fromEntries(register.map((e) => [e.id, e]));
  const fields = fieldIndex(register);
  const usedPrices = register.filter((e) => e.kind === "price" && usedPriceIds.includes(e.priceId));
  const worst = (cat) => {
    const xs = usedPrices.filter((e) => cat(e));
    return xs.length ? xs.reduce((a, b) => (RANK[b.confidence] < RANK[a.confidence] ? b : a)).confidence : "estimate";
  };
  switch (factorId) {
    case "llmPrice":
      return worst((e) => e.priceId.startsWith("llm_"));
    case "gpuPrice":
      return worst((e) => e.priceId.startsWith("gpu_") && !e.priceId.startsWith("gpu_throughput"));
    case "gpuThroughput":
      return "estimate";
    case "engineerHourly":
      return byId.engineer_hourly?.confidence ?? "estimate";
    case "staffHourly":
      return byId.staff_hourly?.confidence ?? "estimate";
    case "maintenanceHours":
      return byId.maintenance_hours?.confidence ?? "estimate";
    case "openModelGap":
      return byId.open_model_gap?.confidence ?? "estimate";
    default:
      return fields[factorId]?.confidence ?? "estimate";
  }
}
