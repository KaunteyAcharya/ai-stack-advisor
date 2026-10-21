// Input validation: errors block calculation, warnings are shown but allowed.

import { AGENT_USE_CASES } from "./agents.js";

const PERCENT_FIELDS = ["peakSharePct", "growthPct", "marginPct", "conversionPct", "deflectionPct", "targetSharePct", "humanSharePct", "customTaxPct", "successPct", "reviewPct", "errorPct", "xRepliesSharePct", "cachedSharePct", "openModelGapPct", "discountRatePct"];
const OPTIONAL_PERCENT_FIELDS = ["shareSelfPct", "costWeightPct"]; // null = automatic
const NON_NEGATIVE_FIELDS = [
  "usersPerDay", "requestsPerUser", "seats", "inTokens", "outTokens", "voiceMinutesPerConversation",
  "docsPerMonth", "pagesPerDoc", "tokensPerPage", "docOutTokens", "ocrCostPerPageUsd",
  "engineerHourlyUsd", "ticketUsd", "purchasesPerYear", "ltvUsd",
  "conversationsPerMonth", "humanCostPerConvUsd", "growthMonths",
  "tasksPerMonth", "stepsPerTask", "inTokensPerStep", "contextGrowthPerStep", "outTokensPerStep", "pagesPerTask",
  "saasStepsPerTask", "externalFeePerTaskUsd", "humanMinutesPerTask", "reviewMinutes", "costPerErrorUsd",
  "staffHourlyUsd", "fteHoursPerMonth", "marketDataMonthlyUsd", "videosPerMonth", "secondsPerVideo", "imagesPerMonth",
  "xPostsPerMonth", "repliesPerMonth", "replyInTokens", "replyOutTokens", "minutesSavedPerRequest",
];

export const STALE_FX_DAYS = 14;

/**
 * @param inputs  the inputs object
 * @param ctx     { presets, regions, fx, today: "YYYY-MM-DD" }
 * @returns { errors: [{field, message}], warnings: [{field, message, level}] }
 */
export function validateInputs(inputs, ctx = {}) {
  const errors = [];
  const warnings = [];

  for (const f of NON_NEGATIVE_FIELDS) {
    const v = inputs[f];
    if (v == null) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) errors.push({ field: f, message: `${f} must be a number.` });
    else if (v < 0) errors.push({ field: f, message: `${f} cannot be negative.` });
  }
  for (const f of [...PERCENT_FIELDS, ...OPTIONAL_PERCENT_FIELDS]) {
    const v = inputs[f];
    if (v == null && OPTIONAL_PERCENT_FIELDS.includes(f)) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      errors.push({ field: f, message: `${f} must be between 0 and 100.` });
    }
  }
  if (AGENT_USE_CASES.includes(inputs.useCase)) {
    if (!(inputs.tasksPerMonth > 0)) errors.push({ field: "tasksPerMonth", message: "Tasks per month must be greater than zero." });
    if (!(inputs.fteHoursPerMonth > 0)) errors.push({ field: "fteHoursPerMonth", message: "Working hours per FTE must be greater than zero." });
    if (inputs.successPct + inputs.errorPct > 100) warnings.push({ field: "successPct", level: "warning", message: "Success rate plus error rate is above 100%." });
    if (inputs.stepsPerTask > 30) warnings.push({ field: "stepsPerTask", level: "warning", message: "More than 30 steps per task is unusual; context cost grows with every step." });
  } else if (!(inputs.usersPerDay > 0)) errors.push({ field: "usersPerDay", message: "Users per day must be greater than zero." });
  for (const [h, v] of Object.entries({ ...prefix("buildHours", inputs.buildHours), ...prefix("maintenanceHours", inputs.maintenanceHours), ...prefix("evalHours", inputs.evalHours) })) {
    if (!(v >= 0)) errors.push({ field: h, message: `${h} cannot be negative.` });
  }

  // Ticket size implausibly small for the preset (compared in USD so it works in any currency).
  const preset = ctx.presets?.presets?.[inputs.industry];
  if (preset && inputs.ticketUsd < preset.min_plausible_ticket_usd) {
    const hint = inputs.displayCurrency === "INR" ? "Did you mean lakh?" : "Did you mean thousands (k) or millions (M)?";
    warnings.push({ field: "ticketUsd", level: "warning", message: `Ticket size looks very small for ${preset.label}. ${hint}` });
  }

  const region = ctx.regions?.regions?.find((r) => r.code === inputs.region);
  if (region && inputs.displayCurrency && region.currency !== inputs.displayCurrency) {
    warnings.push({ field: "displayCurrency", level: "info", message: `Results shown in ${inputs.displayCurrency} for a company in ${region.name === "United Arab Emirates" ? "the UAE" : region.name}.` });
  }

  if (ctx.fx && ctx.today) {
    const ageDays = (Date.parse(ctx.today) - Date.parse(ctx.fx.as_of)) / 86_400_000;
    if (ageDays > STALE_FX_DAYS) {
      warnings.push({ field: "fx", level: "info", message: `Reference rates dated ${ctx.fx.as_of}.` });
    }
  }

  if (inputs.conversionPct > 50) warnings.push({ field: "conversionPct", level: "warning", message: "Conversion rate above 50% is unusually high." });
  if (inputs.growthPct > 30) warnings.push({ field: "growthPct", level: "warning", message: "Growth above 30% per month compounds very fast over 36 months." });
  if (inputs.requestsPerUser > 100) warnings.push({ field: "requestsPerUser", level: "warning", message: "More than 100 requests per user per day is unusual." });

  return { errors, warnings };
}

function prefix(name, obj = {}) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`${name}.${k}`, v]));
}
