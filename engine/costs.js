// Monthly cost of each option, in USD. Month index m = 0 is month 1.
// Every function returns { total, lines, priceIds, ... } so the report can show its workings.

import { gpuSizing, kvRoomGb, selectGpu } from "./capacity.js";
import { taxProfile, applyTax } from "./tax.js";
import { isAgent, agentTokens, workflowExtraLines } from "./agents.js";

export const DAYS_PER_MONTH = 30;
export const HOURS_PER_MONTH = 730;

const pct = (x) => x / 100;

/** A line's workings: quantity × rate (USD), shown as "200,040 requests × $0.00145". */
const basis = (qty, unit, rate) => [{ qty, unit, rate }];

/** Default hybrid share when none is chosen (the recommendation engine searches for the cheapest). */
export const DEFAULT_SHARE_SELF = 0.7;
export const shareSelfOf = (inputs) => (inputs.shareSelfPct == null ? DEFAULT_SHARE_SELF : pct(inputs.shareSelfPct));

/**
 * Volume in month m. `scale` multiplies all traffic (used by the cost-vs-volume curve).
 * Depends on use case:
 *  - document_processing: one request per document (pages × tokens/page in), plus optional
 *    chat-over-documents requests from users. Users/day is otherwise only used for seat pricing.
 *  - workflow agents: tasks × steps per task (each step is one LLM call, context growing per
 *    step), plus replies on your own posts for the content engine.
 *  - all others: users/day × requests/user.
 * Growth applies for the first `growthMonths` months, then volume stays flat.
 * Returns average tokens per request so cost stays exact (LLM cost is linear in tokens).
 */
export function volume(inputs, m = 0, scale = 1) {
  const growthMonths = inputs.growthMonths ?? Infinity;
  const g = Math.pow(1 + pct(inputs.growthPct), Math.min(m, growthMonths)) * scale;
  const groups = [];
  let conversations;

  let tasks = 0;
  if (isAgent(inputs)) {
    tasks = inputs.tasksPerMonth * g;
    const t = agentTokens(inputs);
    groups.push({ count: tasks * t.callsPerTask, inTokens: t.avgInTokens, outTokens: t.outTokens });
    if (inputs.useCase === "content_engine" && inputs.repliesPerMonth > 0) {
      groups.push({ count: inputs.repliesPerMonth * g, inTokens: inputs.replyInTokens, outTokens: inputs.replyOutTokens });
    }
    conversations = tasks;
  } else if (inputs.useCase === "document_processing") {
    const docs = inputs.docsPerMonth * g;
    groups.push({ count: docs, inTokens: inputs.pagesPerDoc * inputs.tokensPerPage, outTokens: inputs.docOutTokens });
    conversations = docs;
    if (inputs.chatOverDocs) {
      const chats = inputs.usersPerDay * inputs.requestsPerUser * DAYS_PER_MONTH * g;
      groups.push({ count: chats, inTokens: inputs.inTokens, outTokens: inputs.outTokens });
      conversations = inputs.usersPerDay * DAYS_PER_MONTH * g;
    }
  } else {
    groups.push({ count: inputs.usersPerDay * inputs.requestsPerUser * DAYS_PER_MONTH * g, inTokens: inputs.inTokens, outTokens: inputs.outTokens });
    conversations = inputs.usersPerDay * DAYS_PER_MONTH * g;
  }
  if (inputs.conversationsPerMonth != null && !isAgent(inputs)) conversations = inputs.conversationsPerMonth * g;

  const requests = groups.reduce((s, x) => s + x.count, 0);
  const avg = (k) => (requests > 0 ? groups.reduce((s, x) => s + x.count * x[k], 0) / requests : 0);
  return {
    requestsPerMonth: requests,
    conversationsPerMonth: conversations,
    peakRequestsPerSec: ((requests / DAYS_PER_MONTH) * pct(inputs.peakSharePct)) / 3600,
    avgInTokens: avg("inTokens"),
    avgOutTokens: avg("outTokens"),
    pagesPerMonth: inputs.useCase === "document_processing" ? inputs.docsPerMonth * inputs.pagesPerDoc * g : tasks * (inputs.pagesPerTask || 0),
    tasks,
    growth: g,
  };
}

/**
 * Cost of one LLM call. `cachedShare` (0–1) of the input is served from the provider's cache
 * at the cached-input price (prompt caching).
 */
export function llmCostPerRequest(inTokens, outTokens, model, cachedShare = 0) {
  const cachedPrice = Math.min(model.cached_input_price ?? model.input_price, model.input_price);
  return (inTokens * (1 - cachedShare) * model.input_price + inTokens * cachedShare * cachedPrice + outTokens * model.output_price) / 1_000_000;
}

/** Share of input served from cache: only for prompts at or above the provider's minimum cacheable size. */
export function cachedShareFor(inputs, model, avgInTokens) {
  if (model.cached_input_price == null || !(inputs.cachedSharePct > 0)) return 0;
  return avgInTokens >= (model.cache_min_tokens ?? 0) ? pct(inputs.cachedSharePct) : 0;
}

const cacheNote = (c) => (c > 0 ? `, ${Math.round(c * 100)}% of input cached` : "");

/**
 * Price multiplier for month m when prices change `pctPerYear` a year (−30 = 30% cheaper
 * each year), compounded monthly: (1 + pct/100)^(m/12). Month 1 (m = 0) is today's price.
 */
export function priceChangeFactor(pctPerYear, m) {
  if (!pctPerYear || !m) return 1;
  return Math.pow(1 + Math.max(-99, pctPerYear) / 100, m / 12);
}
export const llmPriceFactor = (inputs, m) => priceChangeFactor(inputs.llmPriceChangePct, m);
export const gpuPriceFactor = (inputs, m) => priceChangeFactor(inputs.gpuPriceChangePct, m);

/** Batch prices for an agent workflow with `useBatch`, where the model lists them (work runs within ~24 hours). */
function withBatch(inputs, model, allowBatch) {
  if (model && allowBatch && inputs.useBatch && isAgent(inputs) && model.batch_input_price != null) {
    return { ...model, input_price: model.batch_input_price, output_price: model.batch_output_price, label: `${model.label}, batch`, batch: true };
  }
  return model;
}

/** Cost of one request at month-1 prices, with prompt caching where it applies. */
export function requestCost(inputs, model, v) {
  return llmCostPerRequest(v.avgInTokens, v.avgOutTokens, model, cachedShareFor(inputs, model, v.avgInTokens));
}

/**
 * Every provider's model for the quality need, each priced for this workload's request mix
 * (batch and caching included), cheapest first. Providers without a model in that role are left
 * out (e.g. no premium model), unless none has one.
 */
export function llmCandidates(inputs, prices, { allowBatch = true, v = volume(inputs, 0) } = {}) {
  const providers = Object.entries(prices.llmByProvider || { default: prices.llm });
  const quality = providers.some(([, tiers]) => tiers[inputs.quality]) ? inputs.quality : "good";
  return providers
    .filter(([, tiers]) => tiers[quality])
    .map(([provider, tiers]) => {
      const model = withBatch(inputs, tiers[quality], allowBatch);
      return { provider, model: { ...model, provider }, perRequest: requestCost(inputs, model, v) };
    })
    .sort((a, b) => a.perRequest - b.perRequest);
}

/**
 * LLM pricing for the quality need: the chosen provider's model in that role, or with
 * `llmProvider: "cheapest"` the provider that costs least for this workload's request mix.
 * Batch prices apply to agent workflows with `useBatch` where the provider lists them.
 */
export function llmModelFor(inputs, prices, { allowBatch = true, v } = {}) {
  const chosen = prices.llmByProvider?.[inputs.llmProvider];
  if (chosen) {
    // A provider without a model in that role falls back to its mid model.
    const model = chosen[inputs.quality] || chosen.good;
    return withBatch(inputs, { ...model, provider: inputs.llmProvider }, allowBatch);
  }
  if (inputs.llmProvider === "cheapest" && prices.llmByProvider) {
    return llmCandidates(inputs, prices, { allowBatch, v: v || volume(inputs, 0) })[0].model;
  }
  return withBatch(inputs, prices.llm[inputs.quality] || prices.llm.good, allowBatch);
}

/** Open-weight model for the quality need, served per token by an inference provider (option E). */
export function openModelFor(inputs, prices, { allowBatch = true } = {}) {
  const model = prices.openLlm?.[inputs.quality] || prices.openLlm?.good;
  return withBatch(inputs, model, allowBatch);
}

/** Voice add-on. Self-hosted STT/TTS is absorbed in GPU sizing, so only telephony applies. */
export function voiceMonthly(inputs, prices, conversations, selfHosted = false) {
  if (inputs.useCase !== "voice_agent") return { total: 0, lines: [], priceIds: [] };
  const minutes = conversations * inputs.voiceMinutesPerConversation;
  const tel = prices.telephony[inputs.region] || prices.telephony.default;
  const lines = [{ label: "Telephony", usd: minutes * tel.price, basis: basis(minutes, "minutes", tel.price) }];
  const priceIds = [tel.id];
  if (!selfHosted) {
    const ttsPerMin = (prices.tts.price * inputs.ttsCharsPerMinute) / 1000;
    lines.push({ label: "Speech-to-text", usd: minutes * prices.stt.price, basis: basis(minutes, "minutes", prices.stt.price) });
    lines.push({ label: "Text-to-speech", usd: minutes * ttsPerMin, basis: basis(minutes, "minutes", ttsPerMin) });
    priceIds.push(prices.stt.id, prices.tts.id);
  }
  return { total: sum(lines), lines, priceIds, minutes };
}

/** OCR, per-task fees, media, social APIs and market data: the same for every option. */
function extras(inputs, prices, v) {
  return workflowExtraLines(inputs, prices, v);
}

/**
 * A build on a per-token model API + managed database + light hosting. Shared by option B
 * (frontier models from the chosen provider) and option E (open models hosted per token).
 * Per-token prices follow `llmPriceChangePct` from month 1.
 */
function tokenApiMonthly(inputs, prices, m, scale, model, option, prefix) {
  const v = volume(inputs, m, scale);
  const cached = cachedShareFor(inputs, model, v.avgInTokens);
  const perReq = llmCostPerRequest(v.avgInTokens, v.avgOutTokens, model, cached) * llmPriceFactor(inputs, m);
  const lines = [
    { label: `${prefix} (${model.label}${cacheNote(cached)})`, usd: v.requestsPerMonth * perReq, llm: true, basis: basis(v.requestsPerMonth, "requests", perReq) },
    ...sharedInfraLines(inputs, prices),
    { label: "Maintenance labour", usd: inputs.maintenanceHours[option] * inputs.engineerHourlyUsd, labour: true, basis: basis(inputs.maintenanceHours[option], "hours", inputs.engineerHourlyUsd) },
  ];
  const ex = extras(inputs, prices, v);
  lines.push(...ex.lines);
  const voice = voiceMonthly(inputs, prices, v.conversationsPerMonth, false);
  lines.push(...voice.lines);
  return {
    total: sum(lines),
    lines,
    llmMonthly: lines[0].usd,
    llmCostPerRequest: perReq,
    model,
    priceIds: [model.id, ...sharedInfraIds(inputs, prices), ...ex.priceIds, ...voice.priceIds],
  };
}

/** Option B — hosted frontier LLM APIs + managed database + light hosting. */
export function apiMonthly(inputs, prices, m = 0, scale = 1) {
  return tokenApiMonthly(inputs, prices, m, scale, llmModelFor(inputs, prices), "B", "LLM API");
}

/**
 * Option E — an open-weight model of the same size class as self-hosting, run per token by an
 * inference provider: no GPUs to manage, but data goes to that provider.
 */
export function hostedOpenMonthly(inputs, prices, m = 0, scale = 1) {
  const model = openModelFor(inputs, prices);
  if (!model) return { total: Infinity, lines: [], priceIds: [], flags: [], unavailable: "No hosted open-model price in the price data" };
  return tokenApiMonthly(inputs, prices, m, scale, model, "E", "Hosted open model");
}

/** GPU sizing details for the self-hosted part (exported for the report). */
export function gpuPlan(inputs, prices, v, share = 1) {
  const sel = selectGpu(inputs.quality, prices.selfhost, prices.gpu, v.avgInTokens + v.avgOutTokens);
  const gpu = prices.gpu[sel.gpuClass];
  const thr = prices.throughput[sel.gpuClass];
  const overhead = inputs.useCase === "voice_agent" && inputs.latency === "realtime" ? prices.selfhost.realtime_voice_overhead : 1;
  const load = gpuLoadArgs(inputs, prices, v, sel, gpu, thr, overhead);
  const sizing = gpuSizing({
    ...load,
    peakRequestsPerSec: v.peakRequestsPerSec * share,
    highAvailability: inputs.uptime === "high_availability",
    headroom: prices.selfhost.headroom,
  });
  return { ...sel, gpu, thr, gpus: sizing.gpus, sizing, overhead };
}

/** Per-request figures for GPU sizing (engine/capacity.js gpuLoad), without the request rate. */
export function gpuLoadArgs(inputs, prices, v, sel, gpu, thr, overhead) {
  return {
    inTokens: v.avgInTokens,
    outTokens: v.avgOutTokens,
    gpuTokensPerSec: thr.value,
    prefillTokensPerSec: thr.prefill_tokens_per_second ?? 0,
    // Self-hosted servers cache repeated prompt prefixes too (no provider minimum).
    cachedShare: pct(inputs.cachedSharePct ?? 0),
    overhead,
    kvGbPerGpu: kvRoomGb(gpu, sel.model, prices.selfhost),
    kvMbPerToken: sel.model.kv_mb_per_token ?? 0,
    streamTokensPerSec: prices.selfhost.stream_tokens_per_sec ?? 0,
  };
}

/**
 * Option C — open model on rented GPUs. `share` (0–1) of traffic is served here
 * (1 for pure self-hosting, share_self for the hybrid's self-hosted part).
 */
export function selfhostMonthly(inputs, prices, m = 0, scale = 1, { share = 1, maintenanceHours = inputs.maintenanceHours.C, includeVoice = true, includeExtras = true } = {}) {
  const v = volume(inputs, m, scale);
  const plan = gpuPlan(inputs, prices, v, share);
  const gpuRate = plan.gpu.price * gpuPriceFactor(inputs, m);
  const lines = [
    { label: `GPU rental (${plan.gpus} × ${plan.gpu.label})`, usd: plan.gpus * gpuRate * HOURS_PER_MONTH, gpu: true, basis: basis(plan.gpus * HOURS_PER_MONTH, "GPU-hours", gpuRate) },
    { label: prices.selfManagedDb.label, usd: prices.selfManagedDb.price, shared: true },
    { label: prices.storage.label, usd: prices.storage.price, shared: true },
    { label: prices.monitoring.label, usd: prices.monitoring.price, shared: true },
    { label: "Operations labour", usd: maintenanceHours * inputs.engineerHourlyUsd, labour: true, basis: basis(maintenanceHours, "hours", inputs.engineerHourlyUsd) },
  ];
  const priceIds = [plan.gpu.id, plan.thr.id, prices.selfManagedDb.id, prices.storage.id, prices.monitoring.id];
  if (includeExtras) {
    const ex = extras(inputs, prices, v);
    lines.push(...ex.lines);
    priceIds.push(...ex.priceIds);
  }
  if (includeVoice) {
    const voice = voiceMonthly(inputs, prices, v.conversationsPerMonth, true);
    lines.push(...voice.lines);
    priceIds.push(...voice.priceIds);
  }
  return {
    total: sum(lines),
    lines,
    gpus: plan.gpus,
    sizing: { ...plan.sizing, contextFits: plan.contextFits },
    flags: plan.contextFits ? [] : ["one request's context does not fit in a single GPU's memory; serving it needs larger GPUs or a model split across GPUs, which is not costed"],
    gpuClass: plan.gpuClass,
    modelClass: plan.modelClass,
    gpuMonthly: lines[0].usd,
    opsMonthly: lines[4].usd,
    priceIds,
  };
}

/** Seat price for the chosen billing period (annual falls back to the single listed price). */
export function seatPrice(plan, billing = "annual") {
  return billing === "annual" && plan.per_seat_price_annual != null ? plan.per_seat_price_annual : plan.per_seat_price;
}

/**
 * Cost of one SaaS plan, or null if it does not apply to this use case.
 * `ctx` = { v: volume, llm: { monthly, perRequest, requests } } for per-task workflow plans,
 * which run AI steps on the customer's own LLM API key (standard, non-batch prices).
 */
export function saasPlanCost(plan, inputs, conversations, ctx = {}) {
  if (plan.use_cases && !plan.use_cases.includes(inputs.useCase)) return null;
  const seats = Math.max(plan.min_seats || 0, inputs.seats);
  if (plan.pricing_type === "per_seat") {
    // Internal tools: every person using it each day needs a seat.
    const seatsNeeded = Math.max(seats, Math.ceil(inputs.usersPerDay || 0));
    const price = seatPrice(plan, inputs.saasBilling);
    return { cost: seatsNeeded * price, viable: plan.max_seats == null || seatsNeeded <= plan.max_seats, seats: seatsNeeded, basis: basis(seatsNeeded, "seats", price) };
  }
  if (plan.pricing_type === "per_conversation") {
    return { cost: plan.monthly_price, viable: plan.max_conversations_per_month == null || conversations <= plan.max_conversations_per_month };
  }
  if (plan.pricing_type === "per_resolution") {
    const resolutions = conversations * pct(inputs.deflectionPct);
    const price = seatPrice(plan, inputs.saasBilling);
    return {
      cost: seats * price + resolutions * plan.per_resolution_price,
      viable: true,
      seats,
      resolutions,
      basis: [...basis(seats, "seats", price), ...basis(resolutions, "resolutions", plan.per_resolution_price)],
    };
  }
  if (plan.pricing_type === "per_task") {
    const needed = (ctx.v?.tasks ?? 0) * (inputs.saasStepsPerTask || 1);
    const tiers = plan.task_tiers;
    const tier = tiers.find((t) => t.tasks >= needed) || tiers[tiers.length - 1];
    const price = inputs.saasBilling === "monthly" ? tier.monthly : tier.annual;
    const llm = ctx.llm || { monthly: 0, perRequest: 0, requests: 0 };
    return {
      cost: price + llm.monthly,
      viable: needed <= tiers[tiers.length - 1].tasks,
      tierTasks: tier.tasks,
      basis: [...basis(1, `plan (${tier.tasks.toLocaleString("en-US")} tasks)`, price), ...basis(llm.requests, "LLM requests on your API key", llm.perRequest)],
    };
  }
  throw new Error(`Unknown SaaS pricing type: ${plan.pricing_type}`);
}

/**
 * Option A — SaaS. Three pricing types (per seat, per conversation tiered, per resolution
 * with required base seats). The cheapest plan whose limits fit the volume is used.
 */
export function saasMonthly(inputs, prices, m = 0, scale = 1) {
  const v = volume(inputs, m, scale);
  const std = llmModelFor(inputs, prices, { allowBatch: false });
  const perReq = requestCost(inputs, std, v) * llmPriceFactor(inputs, m);
  const ctx = { v, llm: { monthly: v.requestsPerMonth * perReq, perRequest: perReq, requests: v.requestsPerMonth } };
  const candidates = prices.saasTiers
    .map((plan) => ({ plan, r: saasPlanCost(plan, inputs, v.conversationsPerMonth, ctx) }))
    .filter((c) => c.r);
  if (!candidates.length) {
    return { total: Infinity, lines: [], priceIds: [], flags: [], unavailable: "No off-the-shelf SaaS plan in the price data fits this use case" };
  }
  const flags = [];
  let pool = candidates.filter((c) => c.r.viable);
  if (!pool.length) {
    pool = candidates;
    flags.push("volume exceeds plan limit; contact the vendor for a custom quote");
  }
  const best = pool.sort((a, b) => a.r.cost - b.r.cost)[0];
  const lines = [
    { label: `SaaS: ${best.plan.label}${best.r.seats ? `, ${inputs.saasBilling === "monthly" ? "monthly" : "annual"} billing` : ""}`, usd: best.r.cost, basis: best.r.basis },
    { label: "Maintenance labour", usd: inputs.maintenanceHours.A * inputs.engineerHourlyUsd, labour: true, basis: basis(inputs.maintenanceHours.A, "hours", inputs.engineerHourlyUsd) },
  ];
  const ex = extras(inputs, prices, v);
  lines.push(...ex.lines);
  const voice = voiceMonthly(inputs, prices, v.conversationsPerMonth, false);
  lines.push(...voice.lines);
  const priceIds = [best.plan.id, ...ex.priceIds, ...voice.priceIds];
  if (best.plan.pricing_type === "per_task") priceIds.push(std.id);
  return { total: sum(lines), lines, tier: best.plan.id, pricingType: best.plan.pricing_type, flags, priceIds };
}

/**
 * Option D — share_self of requests on self-hosted GPUs, the rest via API,
 * plus shared infrastructure (managed DB, hosting, vector DB).
 */
export function hybridMonthly(inputs, prices, m = 0, scale = 1, shareSelf = shareSelfOf(inputs)) {
  const v = volume(inputs, m, scale);
  const self = selfhostMonthly(inputs, prices, m, scale, { share: shareSelf, maintenanceHours: inputs.maintenanceHours.D, includeVoice: false, includeExtras: false });
  const model = llmModelFor(inputs, prices);
  const perReq = requestCost(inputs, model, v) * llmPriceFactor(inputs, m);
  const lines = [
    ...self.lines,
    { label: `LLM API for ${Math.round((1 - shareSelf) * 100)}% of requests (${model.label})`, usd: v.requestsPerMonth * perReq * (1 - shareSelf), llm: true, basis: basis(v.requestsPerMonth * (1 - shareSelf), "requests", perReq) },
    ...sharedInfraLines(inputs, prices),
  ];
  const ex = extras(inputs, prices, v);
  lines.push(...ex.lines);
  const priceIds = [...self.priceIds, ...sharedInfraIds(inputs, prices), ...ex.priceIds];
  if (shareSelf < 1) priceIds.push(model.id);
  // Calls served by the API share use hosted STT/TTS; the self-hosted share only pays telephony.
  const voiceSelf = voiceMonthly(inputs, prices, v.conversationsPerMonth * shareSelf, true);
  const voiceApi = voiceMonthly(inputs, prices, v.conversationsPerMonth * (1 - shareSelf), false);
  lines.push(...mergeLines([...voiceSelf.lines, ...voiceApi.lines]));
  priceIds.push(...voiceSelf.priceIds, ...voiceApi.priceIds);
  return { total: sum(lines), lines, gpus: self.gpus, shareSelf, priceIds };
}

/**
 * Monthly cost of every option for month m, including any tax that cannot be reclaimed.
 * `shareSelf` overrides the hybrid split (cheapest split, or 1 when data may not leave).
 */
export function monthlyCosts(inputs, prices, m = 0, scale = 1, { shareSelf } = {}) {
  const tax = taxProfile(inputs, prices.taxes);
  return {
    A: applyTax(saasMonthly(inputs, prices, m, scale), tax),
    B: applyTax(apiMonthly(inputs, prices, m, scale), tax),
    C: applyTax(selfhostMonthly(inputs, prices, m, scale), tax),
    D: applyTax(hybridMonthly(inputs, prices, m, scale, shareSelf ?? shareSelfOf(inputs)), tax),
    E: applyTax(hostedOpenMonthly(inputs, prices, m, scale), tax),
  };
}

/** One-time cost: build hours plus evaluation hours (testing quality on your own data), × engineer rate. */
export function oneTimeHours(inputs, option) {
  return inputs.buildHours[option] + (inputs.evalHours?.[option] ?? 0);
}

export function oneTimeCost(inputs, option) {
  return oneTimeHours(inputs, option) * inputs.engineerHourlyUsd;
}

function sharedInfraLines(inputs, prices) {
  const lines = [
    { label: prices.managedDb.label, usd: prices.managedDb.price, shared: true },
    { label: prices.hosting.label, usd: prices.hosting.price, shared: true },
  ];
  if (inputs.rag) lines.push({ label: prices.vectorDb.label, usd: prices.vectorDb.price, shared: true });
  return lines;
}

function sharedInfraIds(inputs, prices) {
  const ids = [prices.managedDb.id, prices.hosting.id];
  if (inputs.rag) ids.push(prices.vectorDb.id);
  return ids;
}

/** Merges lines with the same label (e.g. telephony from both hybrid shares), keeping workings when the rate matches. */
function mergeLines(lines) {
  const map = new Map();
  for (const l of lines) {
    const prev = map.get(l.label);
    if (!prev) {
      map.set(l.label, { ...l, basis: l.basis ? l.basis.map((b) => ({ ...b })) : undefined });
      continue;
    }
    prev.usd += l.usd;
    const same = prev.basis?.length === 1 && l.basis?.length === 1 && prev.basis[0].rate === l.basis[0].rate;
    prev.basis = same ? [{ ...prev.basis[0], qty: prev.basis[0].qty + l.basis[0].qty }] : undefined;
  }
  return [...map.values()];
}

export function sum(lines) {
  return lines.reduce((s, l) => s + l.usd, 0);
}
