// The single `inputs` object the whole engine works from (schema: docs/inputs.schema.json).
// Money is stored in USD. Percentages are stored as 0–100 numbers.

export const OPTION_IDS = ["A", "B", "C", "D"];

export const OPTION_LABELS = {
  A: "SaaS subscription",
  B: "API-based custom build",
  C: "Self-hosted open source",
  D: "Hybrid",
};

export const DEFAULT_INPUTS = {
  company: "",
  region: "IN",
  industry: "d2c_ecommerce",
  displayCurrency: "INR",
  compareCurrency: "",
  numberFormat: "auto",

  useCase: "chatbot",
  inTokens: 1500,
  outTokens: 400,
  voiceMinutesPerConversation: 4,
  ttsCharsPerMinute: 750,
  docsPerMonth: 0,
  pagesPerDoc: 5,
  tokensPerPage: 600,
  docOutTokens: 800,
  chatOverDocs: false,
  ocrCostPerPageUsd: 0, // user-entered assumption; 0 = documents are already digital text
  rag: true,
  cachedSharePct: 40, // share of input tokens that repeat across requests and hit the provider's cache

  // Workflow agents (see engine/agents.js). Used when useCase is an agent workflow.
  tasksPerMonth: 2000,
  stepsPerTask: 4,
  inTokensPerStep: 2500,
  contextGrowthPerStep: 400,
  outTokensPerStep: 300,
  pagesPerTask: 0,
  useBatch: true, // use the provider's batch prices (asynchronous work)
  saasStepsPerTask: 4, // workflow-tool tasks (steps) per agent task
  externalFeePerTaskUsd: 0, // e.g. lead enrichment lookups (assumption)
  humanMinutesPerTask: 6,
  successPct: 80, // share of tasks the agent completes without a person
  reviewPct: 20, // share of tasks a person reviews
  reviewMinutes: 2,
  errorPct: 1, // share of tasks with an error that slips through
  costPerErrorUsd: 20,
  staffHourlyUsd: 8, // loaded cost of the person doing the work today (from region)
  fteHoursPerMonth: 160,
  valueUnit: "hours", // hours | fte
  marketDataMonthlyUsd: null, // null = price data default (stock report)
  videosPerMonth: 30,
  secondsPerVideo: 30,
  videoTier: "fast", // lite | fast | standard
  imagesPerMonth: 60,
  xPostsPerMonth: 30,
  repliesPerMonth: 600, // replies to comments on your own posts
  xRepliesSharePct: 30, // share of those replies on X (paid API); the rest via free official APIs
  replyInTokens: 800,
  replyOutTokens: 80,
  minutesSavedPerRequest: 3, // internal tools: staff minutes saved per request

  usersPerDay: 1667,
  requestsPerUser: 4,
  peakSharePct: 15,
  growthPct: 5,
  growthMonths: 12, // growth stops after this many months; volume is flat afterwards
  seats: 3,
  saasBilling: "annual", // annual | monthly — annual seat prices are lower where the vendor lists them

  personalData: true,
  externalAllowed: "yes", // yes | only_no_training | no
  residency: "india",

  latency: "standard", // relaxed | standard | realtime
  uptime: "business_hours", // best_effort | business_hours | high_availability
  quality: "good", // basic | good | best_available

  engineers: "one", // none | one | small_team
  devops: "some", // none | some | strong
  engineerHourlyUsd: 15,

  taxVariant: "", // "" = region default (data/taxes.json)
  taxRegistered: true, // registered for VAT/GST and able to reclaim it
  customTaxPct: 0, // used by tax components without a fixed rate (e.g. US state sales tax)

  ticketUsd: 24,
  marginPct: 40,
  purchaseType: "repeat", // one_time | repeat
  purchasesPerYear: 3,
  ltvUsd: null, // direct 12-month customer value override (USD gross profit), null = compute
  conversationsPerMonth: null, // null = usersPerDay × 30
  conversionPct: 3,
  humanCostPerConvUsd: 0.6,
  humanSharePct: 20, // share of conversations that reach a human today
  deflectionPct: 60,
  targetSharePct: 10,

  shareSelfPct: null, // null = automatic: the cheapest split from 10% to 90%
  buildHours: { A: 20, B: 120, C: 240, D: 300 },
  evalHours: { A: 8, B: 16, C: 32, D: 32 }, // testing quality on your own data before launch (one-time)
  maintenanceHours: { A: 4, B: 10, C: 30, D: 35 },
  weights: { privacy: 25, timeToLaunch: 20, teamFit: 20, quality: 15, lockIn: 10, scalability: 10 },
  costWeightPct: null, // null = automatic (50, or 25 for high-ticket profiles)
  discountRatePct: 10, // annual rate for the present value of 36-month costs
  openModelGapPct: 10, // percentage points fewer tasks completed by self-hosted open models (assumption)

  // Multiple workloads: the fields above describe workload 1; up to two more live here, each
  // holding only WORKLOAD_KEYS. Everything else (country, data rules, team, tax…) is shared.
  workloadName: "",
  extraWorkloads: [],
  extraWorkloadEffortPct: 50, // build and maintenance effort for each extra workload on the same stack

  // Inputs the user marked "not sure": the report also shows results at the low and high end (engine/ranges.js).
  uncertainKeys: [],
};

export const MAX_WORKLOADS = 11; // one per use case

/** Fields that belong to one workload; all other inputs are shared across workloads. */
export const WORKLOAD_KEYS = [
  "workloadName", "useCase", "quality",
  "inTokens", "outTokens", "voiceMinutesPerConversation", "ttsCharsPerMinute", "docsPerMonth", "pagesPerDoc",
  "tokensPerPage", "docOutTokens", "chatOverDocs", "ocrCostPerPageUsd", "rag", "cachedSharePct",
  "tasksPerMonth", "stepsPerTask", "inTokensPerStep", "contextGrowthPerStep", "outTokensPerStep", "pagesPerTask",
  "useBatch", "saasStepsPerTask", "externalFeePerTaskUsd", "humanMinutesPerTask", "successPct", "reviewPct",
  "reviewMinutes", "errorPct", "costPerErrorUsd", "staffHourlyUsd", "marketDataMonthlyUsd", "videosPerMonth",
  "secondsPerVideo", "videoTier", "imagesPerMonth", "xPostsPerMonth", "repliesPerMonth", "xRepliesSharePct",
  "replyInTokens", "replyOutTokens", "minutesSavedPerRequest",
  "usersPerDay", "requestsPerUser", "peakSharePct", "seats",
  "ticketUsd", "marginPct", "purchaseType", "purchasesPerYear", "ltvUsd", "conversationsPerMonth", "conversionPct",
  "humanCostPerConvUsd", "humanSharePct", "deflectionPct", "targetSharePct",
];

/** Every workload as a full inputs object (shared fields + that workload's own fields). */
export function workloadsOf(inputs) {
  const extra = (inputs.extraWorkloads || []).slice(0, MAX_WORKLOADS - 1);
  return [
    { ...inputs, extraWorkloads: [], workloadIndex: 0 },
    ...extra.map((w, i) => ({ ...inputs, ...pickWorkload(w), extraWorkloads: [], workloadIndex: i + 1 })),
  ];
}

/** Only the per-workload fields of an object. */
export function pickWorkload(obj) {
  return Object.fromEntries(WORKLOAD_KEYS.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
}

/** A new workload for `useCase`, starting from the current inputs' values and the use-case defaults. */
export function newWorkload(useCase, inputs, usecasesData) {
  return pickWorkload({ ...pickWorkload(withDefaults()), staffHourlyUsd: inputs.staffHourlyUsd, quality: inputs.quality, ...useCaseDefaults(useCase, usecasesData), workloadName: "" });
}

/** Merge partial inputs over defaults (one level deep for nested objects). */
export function withDefaults(partial = {}) {
  const out = { ...DEFAULT_INPUTS, ...partial };
  for (const key of ["buildHours", "maintenanceHours", "evalHours", "weights"]) {
    out[key] = { ...DEFAULT_INPUTS[key], ...(partial[key] || {}) };
  }
  return out;
}

/** Defaults implied by choosing a country. */
export function regionDefaults(regionCode, regionsData) {
  const r = regionsData.regions.find((x) => x.code === regionCode);
  if (!r) throw new Error(`Unknown region: ${regionCode}`);
  return {
    region: r.code,
    displayCurrency: r.currency,
    locale: r.locale,
    residency: r.residency,
    engineerHourlyUsd: r.engineer_hourly_usd,
    staffHourlyUsd: r.staff_hourly_usd,
    fteHoursPerMonth: r.fte_hours_per_month,
  };
}

/** Values implied by choosing a use case. */
export function useCaseDefaults(useCase, usecasesData) {
  const u = usecasesData.usecases[useCase];
  if (!u) throw new Error(`Unknown use case: ${useCase}`);
  if (u.kind === "agent") {
    const m = u.media || {};
    return {
      useCase,
      rag: u.rag,
      cachedSharePct: u.cached_share_pct ?? 0,
      tasksPerMonth: u.tasks_per_month,
      stepsPerTask: u.steps_per_task,
      inTokensPerStep: u.in_tokens_per_step,
      contextGrowthPerStep: u.context_growth_per_step,
      outTokensPerStep: u.out_tokens_per_step,
      pagesPerTask: u.pages_per_task,
      useBatch: u.batch,
      saasStepsPerTask: u.saas_steps_per_task,
      externalFeePerTaskUsd: u.external_fee_per_task_usd,
      humanMinutesPerTask: u.human_minutes_per_task,
      successPct: u.success_pct,
      reviewPct: u.review_pct,
      reviewMinutes: u.review_minutes,
      errorPct: u.error_pct,
      costPerErrorUsd: u.cost_per_error_usd,
      peakSharePct: u.batch ? 8 : 15,
      ...(u.media
        ? {
            videosPerMonth: m.videos_per_month,
            secondsPerVideo: m.seconds_per_video,
            videoTier: m.video_tier,
            imagesPerMonth: m.images_per_month,
            xPostsPerMonth: m.x_posts_per_month,
            repliesPerMonth: m.replies_per_month,
            xRepliesSharePct: m.x_replies_share_pct,
            replyInTokens: m.reply_in_tokens,
            replyOutTokens: m.reply_out_tokens,
          }
        : {}),
    };
  }
  return {
    useCase,
    inTokens: u.in_tokens,
    outTokens: u.out_tokens,
    voiceMinutesPerConversation: u.voice_minutes_per_conversation ?? 0,
    ttsCharsPerMinute: u.tts_chars_per_minute ?? 750,
    docsPerMonth: u.docs_per_month ?? 0,
    pagesPerDoc: u.pages_per_doc ?? 5,
    tokensPerPage: u.tokens_per_page ?? 600,
    docOutTokens: u.doc_out_tokens ?? 800,
    rag: u.rag,
    cachedSharePct: u.cached_share_pct ?? 0,
    ...(u.users_per_day != null ? { usersPerDay: u.users_per_day, requestsPerUser: u.requests_per_user } : {}),
    ...(u.minutes_saved_per_request != null ? { minutesSavedPerRequest: u.minutes_saved_per_request } : {}),
  };
}

/**
 * Values implied by choosing an industry preset. Money is returned in USD.
 * For INR display, the exact INR anchor values ("india" variant) are converted
 * back to USD so they display as exactly ₹2,000 / ₹65,00,000.
 */
export function presetValues(industry, presetsData, usecasesData, displayCurrency, fx) {
  const p = presetsData.presets[industry];
  if (!p) throw new Error(`Unknown industry: ${industry}`);
  let ticketUsd = p.ticket_usd;
  let humanCostPerConvUsd = p.human_cost_per_conv_usd;
  if (displayCurrency === "INR" && p.india) {
    ticketUsd = p.india.ticket_inr / fx.rates.INR;
    humanCostPerConvUsd = p.india.human_cost_per_conv_inr / fx.rates.INR;
  }
  return {
    industry,
    ...useCaseDefaults(p.use_case, usecasesData),
    usersPerDay: p.users_per_day,
    requestsPerUser: p.requests_per_user,
    ticketUsd,
    marginPct: p.margin_pct,
    purchaseType: p.purchase_type,
    purchasesPerYear: p.purchases_per_year,
    conversionPct: p.conversion_pct,
    humanCostPerConvUsd,
    deflectionPct: p.deflection_pct,
    conversationsPerMonth: null,
    humanSharePct: p.human_share_pct ?? 20,
    taxRegistered: p.tax_reclaimable ?? true,
  };
}

/**
 * Best-guess region from browser locales (e.g. navigator.languages), with no network call.
 * "de-DE" → DE, "en-GB" → GB, "en-IN" → IN; a bare language like "de" maps to its main country.
 */
export function regionFromLocales(locales = [], regionsData, fallback = "US") {
  const codes = new Set(regionsData.regions.map((r) => r.code));
  const languageOnly = { de: "DE", fr: "FR", nl: "NL", fi: "FI", hi: "IN" };
  for (const loc of locales) {
    const region = String(loc).split(/[-_]/).slice(1).find((p) => /^[a-z]{2}$/i.test(p));
    if (region && codes.has(region.toUpperCase())) return region.toUpperCase();
  }
  for (const loc of locales) {
    const lang = String(loc).split(/[-_]/)[0].toLowerCase();
    if (languageOnly[lang]) return languageOnly[lang];
  }
  return fallback;
}
