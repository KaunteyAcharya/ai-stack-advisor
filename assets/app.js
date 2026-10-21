// UI wiring only: builds the form, reads inputs, calls the engine, hands results to render.js.

import { withDefaults, DEFAULT_INPUTS, regionDefaults, useCaseDefaults, presetValues, regionFromLocales, WORKLOAD_KEYS, MAX_WORKLOADS, newWorkload, pickWorkload, workloadsOf } from "../engine/inputs.js";
import { analyzePortfolio, describeCombo, workloadLabel } from "../engine/portfolio.js";
import { indexPrices } from "../engine/prices.js";
import { volume } from "../engine/costs.js";
import { isAgent, isInternal, valuedOnTime } from "../engine/agents.js";
import { validateInputs } from "../engine/validate.js";
import { analyze } from "../engine/recommend.js";
import { CRITERIA } from "../engine/scoring.js";
import { makeFormatter, fromUsd, toUsd, roundSensible } from "./format.js";
import { renderAll, renderPortfolio, renderRange, renderSimulation, renderRegister, el } from "./render.js";
import { RANGE_SPECS, RANGE_KEYS, analyzeRange, rangeBounds } from "../engine/ranges.js";
import { factorsFor, simulateRun, summarize, tornado } from "../engine/simulate.js";
import { buildRegister, fieldIndex } from "../engine/register.js";
import { GOALS, GOAL_GROUPS, GLOSSARY, FIELD_TERMS, HINTS } from "./guide.js";

const STORAGE_KEY = "asa-inputs-v3"; // bump when defaults change meaning (v3: workflow agents)
const MODE_KEY = "asa-mode";
const SCENARIOS_KEY = "asa-scenarios-v1";
const MAX_SCENARIOS = 4;
const $ = (id) => document.getElementById(id);

let data;
let prices;
let state;
let lastResult = null;
let lastPortfolio = null;
let lastRange = null;
let lastValidation = { errors: [], warnings: [] };

/* ---------- workloads: the form edits one workload at a time ---------- */

const WK = new Set(WORKLOAD_KEYS);
let activeW = 0; // 0 = workload 1 (stored at the top level of state), 1–2 = state.extraWorkloads[i − 1]

/** The object that holds the active workload's own fields. */
const activeTarget = () => (activeW > 0 ? state.extraWorkloads[activeW - 1] : state);
/** Shared inputs + the active workload's fields: what the form shows and the detail sections analyse. */
const view = () => (activeW > 0 ? { ...state, ...state.extraWorkloads[activeW - 1] } : state);

function setField(key, value) {
  if (activeW > 0 && WK.has(key)) activeTarget()[key] = value;
  else setPath(state, key, value);
}

/* ---------- field definitions ---------- */

const yesNo = [["true", "Yes"], ["false", "No"]];
const isUse = (...u) => (s) => u.includes(s.useCase);

// type: text | number | percent | money | select | check
const SECTIONS = [
  {
    title: "Business",
    open: true,
    fields: [
      { key: "company", type: "text", label: "Company name", help: "Optional. Only used in the report title." },
      { key: "industry", type: "select", quick: true, label: "Industry", help: "Applies illustrative defaults for the fields below. You can change any of them.", options: () => Object.entries(data.presets.presets).map(([k, p]) => [k, p.label]) },
    ],
  },
  {
    title: "Use case",
    fields: [
      { key: "workloadName", type: "text", label: "Workload name (optional)", help: "Shown in the comparison, for example “Support bot”.", show: () => state.extraWorkloads.length > 0 },
      { key: "useCase", type: "select", label: "Use case", help: "Loads typical token and usage defaults.", options: () => Object.entries(data.usecases.usecases).map(([k, u]) => [k, u.label]) },
      { key: "docsPerMonth", type: "number", label: "Documents per month", unit: "docs", show: isUse("document_processing") },
      { key: "pagesPerDoc", type: "number", label: "Pages per document", unit: "pages", show: isUse("document_processing") },
      { key: "chatOverDocs", type: "check", label: "Chat over documents", help: "Users also ask questions about the documents (adds chat requests from users/day).", show: isUse("document_processing") },
      { key: "voiceMinutesPerConversation", type: "number", label: "Voice minutes per conversation", unit: "min", show: isUse("voice_agent") },
      { key: "rag", type: "check", label: "Uses a knowledge base (RAG)", help: "Adds a vector database to the API and hybrid options." },
      { key: "cachedSharePct", type: "percent", label: "Share of input served from cache", help: "System prompt, instructions and earlier agent steps repeat across requests; providers charge much less for cached input.", advanced: true },
      // Workflow agents
      { key: "tasksPerMonth", type: "number", quick: true, label: "Tasks per month", unit: "tasks", help: "How many times the workflow runs: invoices, leads, reports, tickets or content pieces.", show: (s) => isAgent(s) },
      { key: "pagesPerTask", type: "number", label: "Pages per invoice", unit: "pages", help: "Pages that need OCR.", show: isUse("invoice_processing") },
      { key: "useBatch", type: "check", label: "Run in batch (cheaper API prices)", help: "Work that can wait a few hours uses the provider's batch prices (about 50% lower).", show: (s) => isAgent(s) },
      { key: "externalFeePerTaskUsd", type: "money", decimals: 4, label: "External API fees per task", tag: "assumption", help: "For example a lead-enrichment lookup or an accounting-system API call.", show: (s) => isAgent(s) },
      { key: "marketDataMonthlyUsd", type: "money", optional: true, label: "Market data feed per month", help: "Leave blank for the sample price. Business use and redistribution need a business licence; get a quote.", show: isUse("stock_report") },
      { key: "videosPerMonth", type: "number", label: "AI videos per month", unit: "videos", show: isUse("content_engine") },
      { key: "secondsPerVideo", type: "number", label: "Seconds per video", unit: "sec", show: isUse("content_engine") },
      { key: "videoTier", type: "select", label: "Video model", options: () => [["lite", "Lite (cheapest)"], ["fast", "Fast"], ["standard", "Standard (best quality)"]], show: isUse("content_engine") },
      { key: "imagesPerMonth", type: "number", label: "AI images per month", unit: "images", show: isUse("content_engine") },
      { key: "xPostsPerMonth", type: "number", label: "Posts on X per month", unit: "posts", help: "X charges per post through its API; Instagram and YouTube APIs have no per-call fee.", show: isUse("content_engine") },
      { key: "repliesPerMonth", type: "number", label: "Replies to comments on your own posts", unit: "per month", help: "Only replies on your own posts are modelled. Automated comments on other accounts' posts break platform rules.", show: isUse("content_engine") },
      { key: "xRepliesSharePct", type: "percent", label: "Share of those replies on X", show: isUse("content_engine") },
      { key: "stepsPerTask", type: "number", label: "LLM steps per task", unit: "steps", advanced: true, show: (s) => isAgent(s) },
      { key: "inTokensPerStep", type: "number", label: "Input tokens per step", unit: "tokens", advanced: true, show: (s) => isAgent(s) },
      { key: "contextGrowthPerStep", type: "number", label: "Context added per step", unit: "tokens", help: "Each step re-reads everything so far, so cost grows faster than the number of steps.", advanced: true, show: (s) => isAgent(s) },
      { key: "outTokensPerStep", type: "number", label: "Output tokens per step", unit: "tokens", advanced: true, show: (s) => isAgent(s) },
      { key: "saasStepsPerTask", type: "number", label: "Workflow-tool steps per task", unit: "steps", help: "Each step counts as one task in the workflow tool's plan.", advanced: true, show: (s) => isAgent(s) },
      { key: "replyInTokens", type: "number", label: "Input tokens per reply", unit: "tokens", advanced: true, show: isUse("content_engine") },
      { key: "replyOutTokens", type: "number", label: "Output tokens per reply", unit: "tokens", advanced: true, show: isUse("content_engine") },
      { key: "inTokens", type: "number", label: "Input tokens per chat request", unit: "tokens", advanced: true, show: (s) => s.useCase !== "document_processing" || s.chatOverDocs },
      { key: "outTokens", type: "number", label: "Output tokens per chat request", unit: "tokens", advanced: true, show: (s) => s.useCase !== "document_processing" || s.chatOverDocs },
      { key: "tokensPerPage", type: "number", label: "Tokens per page", unit: "tokens", advanced: true, show: isUse("document_processing") },
      { key: "docOutTokens", type: "number", label: "Output tokens per document", unit: "tokens", advanced: true, show: isUse("document_processing") },
      { key: "ocrCostPerPageUsd", type: "money", decimals: 4, label: "OCR cost per page", help: "Your own assumption. Leave 0 if documents are already digital text.", advanced: true, show: isUse("document_processing") },
      { key: "ttsCharsPerMinute", type: "number", label: "Spoken characters per minute", unit: "chars", advanced: true, show: isUse("voice_agent") },
    ],
  },
  {
    title: "Volume",
    fields: [
      { key: "usersPerDay", type: "number", quick: true, label: "Users per day", unit: "users", help: "People who start a conversation each day." },
      { key: "requestsPerUser", type: "number", label: "Requests per user per day", unit: "messages", step: "any" },
      { key: "peakSharePct", type: "percent", label: "Peak-hour share of daily traffic", help: "Used to size self-hosted GPUs." },
      { key: "growthPct", type: "percent", label: "Monthly growth rate", step: "any" },
      { key: "growthMonths", type: "number", label: "Growth lasts for", unit: "months", help: "After this, volume stays flat. Keeps the 36-month total from depending on an endless growth guess." },
      { key: "seats", type: "number", label: "Internal seats", unit: "seats", help: "Staff who need a SaaS seat (agents or employees)." },
      { key: "saasBilling", type: "select", label: "SaaS billing", help: "Annual seats are cheaper where the vendor lists an annual price; most buyers choose annual.", options: () => [["annual", "Annual (lower seat price)"], ["monthly", "Monthly"]] },
    ],
  },
  {
    title: "Data & compliance",
    fields: [
      { key: "personalData", type: "select", label: "Contains personal data?", options: () => yesNo, bool: true },
      {
        key: "externalAllowed", type: "select", quick: true, label: "May data be sent to external AI providers?", options: () => [
          ["yes", "Yes"],
          ["only_no_training", "Only to providers whose paid terms exclude training"],
          ["no", "No, data must stay on our infrastructure"],
        ],
      },
      {
        key: "residency", type: "select", label: "Data residency requirement", options: () => [
          ["none", "None"], ["india", "India"], ["eu_eea", "EU / EEA"], ["uk", "United Kingdom"], ["switzerland", "Switzerland"],
          ["us", "United States"], ["canada", "Canada"], ["australia", "Australia"], ["uae", "UAE"],
        ],
      },
    ],
  },
  {
    title: "Quality & operations",
    fields: [
      { key: "latency", type: "select", label: "Acceptable response latency", options: () => [["relaxed", "Relaxed"], ["standard", "Standard"], ["realtime", "Real-time"]] },
      { key: "uptime", type: "select", label: "Uptime requirement", options: () => [["best_effort", "Best effort"], ["business_hours", "Business hours"], ["high_availability", "High availability"]] },
      { key: "quality", type: "select", label: "Quality need", help: "Chooses the API model tier and the self-hosted model size.", options: () => [["basic", "Basic"], ["good", "Good"], ["best_available", "Best available"]] },
      { key: "openModelGapPct", type: "percent", label: "Open-model quality gap", tag: "assumption", help: "Percentage points fewer tasks an open model completes than a frontier API model on your task. The value lost is counted as a cost. Measure it with an evaluation." },
    ],
  },
  {
    title: "Team",
    fields: [
      { key: "engineers", type: "select", quick: true, label: "In-house engineers", options: () => [["none", "None"], ["one", "One"], ["small_team", "Small team"]] },
      { key: "devops", type: "select", quick: true, label: "DevOps / MLOps capability", options: () => [["none", "None"], ["some", "Some"], ["strong", "Strong"]] },
      { key: "engineerHourlyUsd", type: "money", label: "Engineer hourly cost", tag: "assumption", help: "Default comes from the region and is a sample value until verified." },
    ],
  },
  {
    title: "Tax",
    fields: [
      {
        key: "taxVariant", type: "select", label: "Tax that applies to you", dynamic: true,
        help: "Vendor prices exclude tax. Pick your province or state where it matters.",
        options: () => (data.taxes.regions[state.region]?.variants || []).map((v) => [v.id, v.label]),
      },
      { key: "taxRegistered", type: "check", label: "Registered for VAT / GST and able to reclaim it", help: "Untick if you are not registered or your sector is exempt (often healthcare, education, finance). Reclaimable tax is then a real cost. US sales tax and Canadian PST are never reclaimable." },
      { key: "customTaxPct", type: "percent", label: "Your sales tax rate", step: "any", help: "Combined state and local rate on SaaS / cloud services.", show: () => currentTaxVariant()?.components.some((c) => c.rate_pct == null) },
    ],
  },
  {
    title: "Value",
    fields: [
      // Internal tools and workflow agents: value = time saved
      { key: "minutesSavedPerRequest", type: "number", quick: true, label: "Staff minutes saved per request", unit: "min", step: "any", help: "Time a person would otherwise spend finding the answer or writing the draft.", show: (s) => isInternal(s) },
      { key: "humanMinutesPerTask", type: "number", label: "Minutes a person spends per task today", unit: "min", step: "any", show: (s) => isAgent(s) },
      { key: "successPct", type: "percent", quick: true, label: "Tasks the agent completes on its own", show: (s) => isAgent(s) },
      { key: "reviewPct", type: "percent", label: "Tasks a person reviews", show: (s) => isAgent(s) },
      { key: "reviewMinutes", type: "number", label: "Minutes per review", unit: "min", step: "any", show: (s) => isAgent(s) },
      { key: "errorPct", type: "percent", label: "Errors that slip through", step: "any", show: (s) => isAgent(s) },
      { key: "costPerErrorUsd", type: "money", label: "Cost of one error", help: "Rework, refunds, a wrong report sent to a client…", show: (s) => isAgent(s) },
      { key: "staffHourlyUsd", type: "money", label: "Hourly cost of the person doing it today", tag: "assumption", help: "Loaded cost (salary plus overheads). Default comes from the region and is a sample value.", show: (s) => valuedOnTime(s) },
      { key: "fteHoursPerMonth", type: "number", label: "Working hours per FTE per month", unit: "hours", show: (s) => valuedOnTime(s) },
      { key: "valueUnit", type: "select", label: "Show time saved as", options: () => [["hours", "Hours per month"], ["fte", "FTEs (full-time equivalents)"]], show: (s) => valuedOnTime(s) },
      { key: "ticketUsd", type: "money", label: "Average ticket size", help: "Price a customer pays per purchase." },
      { key: "marginPct", type: "percent", label: "Gross margin" },
      { key: "purchaseType", type: "select", label: "Purchase type", options: () => [["one_time", "One-time"], ["repeat", "Repeat"]] },
      { key: "purchasesPerYear", type: "number", label: "Purchases per year", unit: "per year", step: "any", show: (s) => s.purchaseType === "repeat" },
      { key: "ltvUsd", type: "money", optional: true, label: "12-month customer value (optional)", help: "Gross profit per new customer over 12 months. Leave blank to calculate it.", show: (s) => s.purchaseType === "repeat" },
      { key: "conversationsPerMonth", type: "number", optional: true, label: "Conversations or leads per month", unit: "per month", help: "Leave blank to use users/day × 30." },
      { key: "conversionPct", type: "percent", label: "Current conversion rate", step: "any" },
      { key: "humanCostPerConvUsd", type: "money", label: "Human cost per conversation", help: "What a support or sales conversation handled by a person costs today." },
      { key: "humanSharePct", type: "percent", label: "Share of conversations that reach a human today", help: "Support savings only count these. Many chats today end without a person." },
      { key: "deflectionPct", type: "percent", label: "Share the AI can fully handle", help: "Deflection rate." },
      { key: "targetSharePct", type: "percent", label: "Max share of conversation value spent on AI" },
    ],
  },
  {
    title: "Advanced: cost model",
    fields: [
      { key: "shareSelfPct", type: "percent", optional: true, label: "Hybrid: share of requests self-hosted", help: "Leave blank to use the cheapest split (searched from 10% to 90%)." },
      ...["A", "B", "C", "D"].map((o) => ({ key: `buildHours.${o}`, type: "number", label: `Build hours, option ${o}`, unit: "hours", tag: "assumption" })),
      ...["A", "B", "C", "D"].map((o) => ({ key: `maintenanceHours.${o}`, type: "number", label: `Maintenance hours/month, option ${o}`, unit: "hours", tag: "assumption" })),
      ...["A", "B", "C", "D"].map((o) => ({ key: `evalHours.${o}`, type: "number", label: `Evaluation hours before launch, option ${o}`, unit: "hours", tag: "assumption" })),
      { key: "discountRatePct", type: "percent", label: "Discount rate (per year)", step: "any", help: "Used for the present value of 36-month costs: money spent later counts for less. 8–12% is common for small businesses." },
    ],
  },
];

const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);

// Chat volume fields don't apply to workflow agents; sales value fields don't apply to anything valued on time saved.
const CHAT_VOLUME = new Set(["inTokens", "outTokens", "usersPerDay", "requestsPerUser", "seats"]);
const SALES_VALUE = new Set([
  "ticketUsd", "marginPct", "purchaseType", "purchasesPerYear", "ltvUsd", "conversationsPerMonth", "conversionPct",
  "humanCostPerConvUsd", "humanSharePct", "deflectionPct", "targetSharePct",
]);
for (const f of ALL_FIELDS) {
  const own = f.show;
  if (CHAT_VOLUME.has(f.key)) f.show = (s) => !isAgent(s) && (!own || own(s));
  else if (SALES_VALUE.has(f.key)) f.show = (s) => !valuedOnTime(s) && (!own || own(s));
}

/* ---------- state helpers ---------- */

const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

const currencyOf = () => state.displayCurrency;

function formatter(currency = state.displayCurrency) {
  return makeFormatter({ currency, numberFormat: state.numberFormat, fx: data.fx, currencies: data.regions.currencies });
}

/* ---------- form building ---------- */

let showAdvanced = false;

function buildForm() {
  const form = $("inputs-form");
  form.replaceChildren();
  for (const section of SECTIONS) {
    const body = el("div", { class: "section-body" });
    for (const f of section.fields) body.append(buildField(f));
    if (section.fields.some((f) => f.advanced)) {
      const btn = el("button", { type: "button", class: "btn-link adv-toggle", "aria-expanded": "false" }, "Show advanced fields");
      btn.addEventListener("click", () => {
        showAdvanced = !showAdvanced;
        refreshVisibility();
      });
      body.append(btn);
    }
    const details = el("details", { open: section.open || null }, el("summary", {}, section.title), body);
    form.append(el("fieldset", { class: "section" }, el("legend", { class: "sr-only" }, section.title), details));
  }
  buildQuickSection(form);
}

/* ---------- quick mode: six questions, everything else from defaults ---------- */

const quickHomes = new Map(); // field key → placeholder comment marking its place in the full form
let mode = "quick";

function buildQuickSection(form) {
  quickHomes.clear();
  const body = el("div", { class: "section-body", id: "quick-body" },
    el("p", { class: "help" }, "A few questions give a first answer. Everything else uses sensible defaults; switch to “All inputs” to fine-tune."),
  );
  const toFull = el("button", { type: "button", class: "btn-link" }, "Fine-tune all inputs");
  toFull.addEventListener("click", () => setMode("full"));
  body.append(toFull);
  form.prepend(el("fieldset", { class: "section quick-section", id: "quick-section" }, el("legend", { class: "sr-only" }, "Quick questions"), body));
  for (const f of ALL_FIELDS.filter((x) => x.quick)) {
    const node = form.querySelector(`.field[data-key="${f.key}"]`);
    const marker = document.createComment(`home:${f.key}`);
    node.before(marker);
    quickHomes.set(f.key, marker);
  }
}

function setMode(next) {
  mode = next === "full" ? "full" : "quick";
  const quickBody = $("quick-body");
  const fineTune = quickBody.querySelector(".btn-link");
  for (const [key, marker] of quickHomes) {
    const node = document.querySelector(`.field[data-key="${key}"]`);
    if (mode === "quick") quickBody.insertBefore(node, fineTune);
    else marker.after(node);
  }
  $("quick-section").classList.toggle("is-hidden", mode !== "quick");
  for (const fs of document.querySelectorAll("#inputs-form fieldset.section:not(#quick-section)")) fs.classList.toggle("is-hidden", mode === "quick");
  $("mode-quick").setAttribute("aria-pressed", String(mode === "quick"));
  $("mode-full").setAttribute("aria-pressed", String(mode === "full"));
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function buildField(f) {
  const id = `f-${f.key.replace(".", "-")}`;
  const hintId = HINTS[f.key] ? `${id}-hint` : null;
  const helpId = [f.help ? `${id}-help` : null, hintId].filter(Boolean).join(" ") || null;
  const term = FIELD_TERMS[f.key];
  const info = term ? infoToggle(term, `${id}-def`) : null;
  // Inputs whose default comes from the assumption register show its confidence instead of a generic tag.
  const conf = REGISTER_FIELDS().has(f.key) ? el("span", { class: "conf", "data-conf": f.key }) : null;
  const labelNode = el("label", { for: id }, f.label, conf || (f.tag ? el("span", { class: "tag" }, f.tag) : null));
  const unsure = RANGE_SPECS[f.key] ? unsureToggle(f.key) : null;
  const extras = [info?.definition, hintId ? el("span", { class: "hint", id: hintId }) : null, unsure ? el("span", { class: "range-hint", id: `${id}-range` }) : null];
  let control;
  if (f.type === "select") {
    control = el("select", { id, name: f.key, "aria-describedby": helpId });
    for (const [v, t] of f.options()) control.append(el("option", { value: v }, t));
  } else if (f.type === "check") {
    control = el("input", { id, name: f.key, type: "checkbox", "aria-describedby": helpId });
    const wrap = el("div", { class: "field check", "data-key": f.key }, control, el("span", { class: "label-row" }, labelNode, info?.button), f.help ? el("span", { class: "help", id: `${id}-help` }, f.help) : null, ...extras);
    control.addEventListener("change", () => onFieldChange(f, control));
    return wrap;
  } else if (f.type === "text") {
    control = el("input", { id, name: f.key, type: "text", maxlength: f.key === "company" ? "80" : "40", autocomplete: f.key === "company" ? "organization" : "off", "aria-describedby": helpId });
  } else {
    control = el("input", {
      id, name: f.key, type: "number", inputmode: "decimal", min: "0",
      max: f.type === "percent" ? "100" : null,
      step: f.step || (f.type === "money" ? "any" : f.type === "percent" ? "any" : "1"),
      placeholder: f.optional ? "auto" : null,
      "aria-describedby": helpId,
    });
  }
  const unit = f.type === "percent" ? "%" : f.type === "money" ? el("span", { class: "unit", "data-currency-unit": "" }, currencyOf()) : f.unit;
  const row = el("div", { class: "input-row" }, control, unit ? (unit instanceof Node ? unit : el("span", { class: "unit" }, unit)) : null);
  control.addEventListener(f.type === "select" ? "change" : "input", () => onFieldChange(f, control));
  return el("div", { class: "field", "data-key": f.key }, el("span", { class: "label-row" }, labelNode, info?.button, unsure), row, f.help ? el("span", { class: "help", id: `${id}-help` }, f.help) : null, ...extras);
}

/* ---------- assumption register ---------- */

let registerCache = null;
/** The register for the current region (labour and tax entries depend on it). */
function currentRegister() {
  if (!registerCache || registerCache.region !== state.region) registerCache = { region: state.region, entries: buildRegister(data, state.region) };
  return registerCache.entries;
}
let registerFieldSet = null;
const REGISTER_FIELDS = () => (registerFieldSet ||= new Set([...data.assumptions.entries.flatMap((e) => e.fields), "staffHourlyUsd", "engineerHourlyUsd"]));

/** Confidence badges next to inputs: the confidence of the default value, with its source on hover. */
function refreshConfidence() {
  const idx = fieldIndex(currentRegister());
  for (const node of document.querySelectorAll("[data-conf]")) {
    const e = idx[node.dataset.conf];
    if (!e) continue;
    node.textContent = e.confidence;
    node.className = `conf conf-${e.confidence}`;
    node.title = `Default is ${e.confidence === "estimate" ? "an estimate" : `a ${e.confidence} figure`}: ${e.source}${e.last_reviewed ? ` (reviewed ${e.last_reviewed})` : ""}. Replace it with your own figure if you have one.`;
  }
}

/** "Not sure" toggle: the report then also shows results with this input at the low and high end. */
function unsureToggle(key) {
  const btn = el("button", { type: "button", class: "unsure-btn", "data-unsure": key, "aria-pressed": "false", title: "Show results for a low and a high value too" }, "Not sure");
  btn.addEventListener("click", () => {
    const keys = new Set(state.uncertainKeys || []);
    keys.has(key) ? keys.delete(key) : keys.add(key);
    state.uncertainKeys = [...keys];
    refreshVisibility();
    compute();
  });
  return btn;
}

/** An ⓘ button that shows a one-line definition from the glossary. */
function infoToggle(term, defId) {
  const definition = el("span", { class: "definition", id: defId, hidden: true }, GLOSSARY[term]);
  const button = el("button", { type: "button", class: "info-btn", "aria-expanded": "false", "aria-controls": defId, "aria-label": "What does this mean?" }, "ⓘ");
  button.addEventListener("click", () => {
    definition.hidden = !definition.hidden;
    button.setAttribute("aria-expanded", String(!definition.hidden));
  });
  return { button, definition };
}

/** Adds ⓘ definitions to result headings marked with data-term. */
function addHeadingInfo() {
  for (const h of document.querySelectorAll("[data-term]")) {
    if (h.querySelector(".info-btn")) continue;
    const { button, definition } = infoToggle(h.dataset.term, `${h.id || h.dataset.term}-def`);
    h.append(" ", button);
    h.after(definition);
  }
}

/** Plain-language hints next to inputs, from the active workload's current values. */
function updateHints() {
  const s = view();
  let vol;
  try {
    vol = volume(s, 0);
  } catch {
    return;
  }
  const fmt = formatter();
  const unit = data.usecases.usecases[s.useCase]?.task_unit || "tasks";
  const c = { n: (x, d = 0) => (Number.isFinite(x) ? fmt.number(x, d) : "—"), money: (usd) => (Number.isFinite(usd) ? fmt.money(usd) : "—"), vol, unit, cacheMin: prices.llm[s.quality]?.cache_min_tokens };
  for (const [key, fn] of Object.entries(HINTS)) {
    const node = document.getElementById(`f-${key}-hint`);
    if (!node) continue;
    let text = null;
    try {
      text = fn(s, c);
    } catch {
      text = null;
    }
    node.textContent = text && !/NaN|—/.test(text) ? text : "";
  }
  const unsure = new Set(state.uncertainKeys || []);
  for (const key of RANGE_KEYS) {
    for (const b of document.querySelectorAll(`[data-unsure="${key}"]`)) b.setAttribute("aria-pressed", String(unsure.has(key)));
    const node = document.getElementById(`f-${key}-range`);
    if (!node) continue;
    const r = unsure.has(key) ? rangeBounds(key, s[key]) : null;
    const pct = key.endsWith("Pct");
    node.textContent = r ? `Range used: ${c.n(r.low, pct ? 1 : 0)}${pct ? "%" : ""} – ${c.n(r.high, pct ? 1 : 0)}${pct ? "%" : ""}${state.extraWorkloads.length ? " (all workloads)" : ""}` : "";
  }
}

function currentTaxVariant() {
  const region = data.taxes.regions[state.region];
  if (!region) return null;
  return region.variants.find((v) => v.id === state.taxVariant) || region.variants.find((v) => v.id === region.default_variant);
}

/** Rebuilds select options that depend on other inputs (e.g. tax variants depend on the country). */
function refreshDynamicOptions() {
  for (const f of ALL_FIELDS.filter((x) => x.dynamic)) {
    const control = document.getElementById(`f-${f.key.replace(".", "-")}`);
    if (!control) continue;
    control.replaceChildren(...f.options().map(([v, t]) => el("option", { value: v }, t)));
  }
  if (!currentTaxVariant() || state.taxVariant !== currentTaxVariant().id) state.taxVariant = currentTaxVariant()?.id ?? "";
}

/** Write state into the form controls. */
function fillForm() {
  refreshDynamicOptions();
  for (const f of ALL_FIELDS) {
    const control = document.getElementById(`f-${f.key.replace(".", "-")}`);
    if (!control) continue;
    const v = getPath(view(), f.key);
    if (f.type === "check") control.checked = !!v;
    else if (f.bool) control.value = String(!!v);
    else if (f.type === "money") control.value = v == null ? "" : String(round(fromUsd(v, currencyOf(), data.fx), f.decimals ?? 2));
    else control.value = v == null ? "" : String(v);
  }
  for (const u of document.querySelectorAll("[data-currency-unit]")) u.textContent = currencyOf();
  $("setup-region").value = state.region;
  $("setup-currency").value = state.displayCurrency;
  $("compare-currency").value = state.compareCurrency || "";
  $("number-format").value = state.numberFormat || "auto";
  renderWorkloadTabs();
  renderGoalPicker();
  refreshConfidence();
  refreshVisibility();
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function refreshVisibility() {
  for (const f of ALL_FIELDS) {
    const node = document.querySelector(`.field[data-key="${f.key}"]`);
    if (!node) continue;
    const visible = (!f.show || f.show(view())) && (!f.advanced || showAdvanced);
    node.classList.toggle("is-hidden", !visible);
  }
  for (const b of document.querySelectorAll(".adv-toggle")) {
    b.textContent = showAdvanced ? "Hide advanced fields" : "Show advanced fields";
    b.setAttribute("aria-expanded", String(showAdvanced));
  }
  updateHints();
}

/* ---------- events ---------- */

function onFieldChange(f, control) {
  let value;
  if (f.type === "check") value = control.checked;
  else if (f.bool) value = control.value === "true";
  else if (f.type === "select" || f.type === "text") value = control.value;
  else if (control.value.trim() === "") value = f.optional ? null : NaN;
  else {
    value = Number(control.value);
    if (f.type === "money") value = toUsd(value, currencyOf(), data.fx);
  }
  setField(f.key, value);

  if (f.key === "industry") applyPreset(value);
  else if (f.key === "useCase") {
    const t = activeTarget();
    Object.assign(t, useCaseDefaults(value, data.usecases));
    if (t.costPerErrorUsd != null) t.costPerErrorUsd = roundIn(t.costPerErrorUsd, state.displayCurrency);
  }
  if (["industry", "useCase", "workloadName"].includes(f.key)) fillForm();
  refreshVisibility();
  scheduleCompute();
}

// Money fields a person types as round figures.
const ROUNDED_MONEY = ["ticketUsd", "humanCostPerConvUsd", "engineerHourlyUsd", "ltvUsd", "staffHourlyUsd", "costPerErrorUsd", "marketDataMonthlyUsd"];

/** USD value of `usd` after rounding it to a natural figure in currency `cur`. */
const roundIn = (usd, cur) => toUsd(roundSensible(fromUsd(usd, cur, data.fx), cur), cur, data.fx);

/**
 * Default money values for the current industry, region and currency, rounded to natural figures.
 * For INR, presets with an India variant use the exact anchor values (e.g. ₹2,000, ₹65 lakh).
 */
function moneyDefaults() {
  const cur = state.displayCurrency;
  const p = presetValues(state.industry, data.presets, data.usecases, cur, data.fx);
  const anchor = cur === "INR" && data.presets.presets[state.industry].india;
  const region = data.regions.regions.find((r) => r.code === state.region);
  return {
    ticketUsd: anchor ? p.ticketUsd : roundIn(p.ticketUsd, cur),
    humanCostPerConvUsd: anchor ? p.humanCostPerConvUsd : roundIn(p.humanCostPerConvUsd, cur),
    engineerHourlyUsd: roundIn(region.engineer_hourly_usd, cur),
    staffHourlyUsd: roundIn(region.staff_hourly_usd, cur),
  };
}

/**
 * Changes country and/or currency. Amounts still at their default are re-derived in the new
 * currency (so they stay round and never drift); amounts the user typed are converted and rounded.
 */
function changeMoneyContext(mutate) {
  const before = moneyDefaults();
  const untouched = Object.keys(before).filter((k) => Math.abs(state[k] - before[k]) <= 0.005 * Math.abs(before[k]));
  mutate();
  const after = moneyDefaults();
  for (const k of ROUNDED_MONEY) {
    if (untouched.includes(k)) state[k] = after[k];
    else if (state[k] != null && Number.isFinite(state[k])) state[k] = roundIn(state[k], state.displayCurrency);
  }
  for (const w of state.extraWorkloads) roundWorkloadMoney(w);
}

/** Rounds a workload's own money fields to natural figures in the working currency. */
function roundWorkloadMoney(w) {
  for (const k of ROUNDED_MONEY) {
    if (WK.has(k) && w[k] != null && Number.isFinite(w[k])) w[k] = roundIn(w[k], state.displayCurrency);
  }
}

function setCurrency(cur) {
  changeMoneyContext(() => {
    state.displayCurrency = cur;
    state.numberFormat = "auto";
    if (state.compareCurrency === cur) state.compareCurrency = "";
  });
}

/** Country sets residency, engineer cost and the working currency (which can then be changed). */
function applyRegion(code) {
  const d = regionDefaults(code, data.regions);
  changeMoneyContext(() => {
    state.region = d.region;
    state.residency = d.residency;
    state.fteHoursPerMonth = d.fteHoursPerMonth;
    state.taxVariant = data.taxes.regions[d.region]?.default_variant ?? "";
    state.displayCurrency = d.displayCurrency;
    state.numberFormat = "auto";
    if (state.compareCurrency === d.displayCurrency) state.compareCurrency = "";
  });
}

/** Applies an industry preset, with money in the working currency. */
function applyPreset(industry) {
  const p = presetValues(industry, data.presets, data.usecases, state.displayCurrency, data.fx);
  state.industry = industry;
  state.taxRegistered = p.taxRegistered;
  const m = moneyDefaults();
  Object.assign(activeTarget(), pickWorkload({ ...p, ticketUsd: m.ticketUsd, humanCostPerConvUsd: m.humanCostPerConvUsd }));
}

let timer;
function scheduleCompute() {
  clearTimeout(timer);
  timer = setTimeout(compute, 200);
}

function compute() {
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { presets: data.presets, regions: data.regions, fx: data.fx, today };
  const ws = workloadsOf(state);
  const multi = ws.length > 1;
  lastValidation = { errors: [], warnings: [] };
  ws.forEach((w, i) => {
    const r = validateInputs(w, ctx);
    const tag = (x) => ({ ...x, workload: i, message: multi && WK.has(x.field) ? `${workloadLabel(w, data.usecases)}: ${x.message}` : x.message });
    lastValidation.errors.push(...r.errors.filter((e) => i === 0 || WK.has(e.field)).map(tag));
    lastValidation.warnings.push(...r.warnings.filter((e) => i === 0 || WK.has(e.field)).map(tag));
  });
  for (const c of document.querySelectorAll("#inputs-form [aria-invalid]")) c.removeAttribute("aria-invalid");
  const errBox = $("error-box");
  if (lastValidation.errors.length) {
    for (const e of lastValidation.errors) if (e.workload === activeW || !WK.has(e.field)) document.getElementById(`f-${e.field.replace(".", "-")}`)?.setAttribute("aria-invalid", "true");
    const where = (e) => (multi && WK.has(e.field) ? `${labelFor(e.field)} (workload ${e.workload + 1})` : labelFor(e.field));
    errBox.replaceChildren(el("strong", {}, "Please fix these inputs: "), [...new Set(lastValidation.errors.map(where))].join(", "), ".");
    errBox.hidden = false;
    $("results-body").setAttribute("aria-busy", "true");
    return;
  }
  errBox.hidden = true;
  $("results-body").removeAttribute("aria-busy");
  lastResult = analyze(view(), prices, { formatMoney: (usd) => formatter().money(usd), formatNumber: (n) => formatter().number(n) });
  lastPortfolio = multi ? analyzePortfolio(state, prices, { usecases: data.usecases }) : null;
  lastRange = analyzeRange(activeW === 0 || multi ? state : view(), prices, { usecases: data.usecases });
  scheduleSimulation();
  render();
  persist();
}

function labelFor(field) {
  return ALL_FIELDS.find((f) => f.key === field)?.label || field;
}

/** Re-render only (e.g. currency change): amounts are stored in USD, so no recalculation. */
function render() {
  if (!lastResult) return;
  const cmp = state.compareCurrency && state.compareCurrency !== state.displayCurrency ? formatter(state.compareCurrency) : null;
  const ctx = {
    inputs: view(),
    fmt: formatter(),
    cmpFmt: cmp,
    data,
    validation: { ...lastValidation, warnings: lastValidation.warnings.filter((w) => w.workload === activeW || !WK.has(w.field)) },
    lawNote: lawNoteFor(state),
  };
  renderAll(lastResult, ctx);
  renderPortfolio(lastPortfolio, { ...ctx, activeW, workloadName: workloadLabel(view(), data.usecases) });
  renderRange(lastRange, ctx);
  renderRegister(lastResult, { ...ctx, register: currentRegister() });
  renderSimulationNow();
  renderSectionNav();
  renderWeights();
  renderScenarios();
  renderResultBar();
}

/* ---------- simulation: runs in small chunks after each change so typing stays smooth ---------- */

const SIM_RUNS = 300;
const SIM_CHUNK = 30;
let simToken = 0;
let lastSim = null;
let lastTornado = null;

function scheduleSimulation() {
  const token = ++simToken;
  const inputs = view();
  const hybridPct = lastResult?.hybrid?.pct;
  lastSim = null;
  lastTornado = null;
  renderSimulationNow();
  setTimeout(async () => {
    if (token !== simToken || !lastResult?.recommended) return;
    lastTornado = tornado(inputs, prices, { hybridPct });
    const factors = factorsFor(inputs, { onlyKeys: inputs.uncertainKeys || [] });
    const samples = [];
    for (let k = 0; k < SIM_RUNS; k += SIM_CHUNK) {
      for (let j = k; j < Math.min(SIM_RUNS, k + SIM_CHUNK); j++) samples.push(simulateRun(inputs, prices, factors, j, { seed: 1, hybridPct }));
      await new Promise((r) => setTimeout(r, 0));
      if (token !== simToken) return; // inputs changed: a newer run has started
    }
    lastSim = { ...summarize(samples), factors };
    renderSimulationNow();
  }, 250);
}

function renderSimulationNow() {
  renderSimulation(lastSim, lastTornado, {
    fmt: formatter(),
    inputs: view(),
    multi: state.extraWorkloads.length > 0,
    workloadName: workloadLabel(view(), data.usecases),
    runs: SIM_RUNS,
    register: currentRegister(),
    usedPriceIds: (lastResult?.pricesUsed || []).map((p) => p.id),
  });
}

/* ---------- executive / analyst view and section strip ---------- */

const VIEW_KEY = "asa-view";
const SECTIONS_NAV = [
  ["portfolio-card", "Workloads"],
  ["sum-title", "Summary"],
  ["compare-card", "Scenarios"],
  ["cmp-title", "Costs"],
  ["curve-title", "Charts"],
  ["value-title", "Value"],
  ["matrix-title", "Decision"],
  ["sim-title", "Confidence"],
  ["warn-title", "Risks"],
  ["assump-title", "Assumptions"],
];

function setView(v) {
  const view = v === "analyst" ? "analyst" : "exec";
  document.body.classList.toggle("view-exec", view === "exec");
  document.body.classList.toggle("view-analyst", view === "analyst");
  $("view-exec").setAttribute("aria-pressed", String(view === "exec"));
  $("view-analyst").setAttribute("aria-pressed", String(view === "analyst"));
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* ignore */
  }
  renderSectionNav();
}

/** Buttons that jump to each visible section of the results. */
function renderSectionNav() {
  const nav = $("section-nav");
  const items = SECTIONS_NAV.map(([id, label]) => {
    const target = document.getElementById(id)?.closest(".card") || document.getElementById(id);
    return target && target.offsetParent !== null && !target.hidden ? [target, label] : null;
  }).filter(Boolean);
  nav.replaceChildren(
    ...items.map(([target, label]) => {
      const b = el("button", { type: "button" }, label);
      b.addEventListener("click", () => target.scrollIntoView({ behavior: "smooth", block: "start" }));
      return b;
    }),
  );
}

/* ---------- "What do you want AI to do?" ---------- */

function renderGoalPicker() {
  const box = $("goal-picker");
  const selected = workloadsOf(state).map((w) => w.useCase);
  const full = selected.length >= MAX_WORKLOADS;
  const groups = GOAL_GROUPS.map((g) =>
    el(
      "div",
      { class: "goal-group" },
      el("p", { class: "goal-group-title" }, g),
      el(
        "div",
        { class: "goal-grid" },
        GOALS.filter((x) => x.group === g).map((goal) => {
          const on = selected.includes(goal.id);
          const btn = el(
            "button",
            { type: "button", class: "goal-card", "aria-pressed": String(on), disabled: !on && full ? true : null },
            el("span", { class: "goal-title" }, goal.title),
            el("span", { class: "goal-desc" }, goal.desc),
          );
          btn.addEventListener("click", () => toggleGoal(goal.id));
          return btn;
        }),
      ),
    ),
  );
  box.replaceChildren(...groups);
  $("goal-count").textContent = `${selected.length} selected`;
}

/** Turns a goal card on or off: each selected goal is one workload (the first one is workload 1). */
function toggleGoal(useCase) {
  const ws = workloadsOf(state);
  const current = ws.map((w) => pickWorkload(w));
  let next;
  if (current.some((w) => w.useCase === useCase)) {
    if (current.length === 1) {
      status("Keep at least one goal selected.");
      return;
    }
    next = current.filter((w) => w.useCase !== useCase);
  } else {
    if (current.length >= MAX_WORKLOADS) return;
    const w = newWorkload(useCase, state, data.usecases);
    roundWorkloadMoney(w);
    next = [...current, w];
  }
  Object.assign(state, next[0]);
  state.extraWorkloads = next.slice(1);
  activeW = Math.min(activeW, next.length - 1);
  fillForm();
  compute();
}

/* ---------- sticky result bar: the answer stays in view while editing ---------- */

let previousHeadline = null;
let deltaTimer;

function renderResultBar() {
  const bar = $("result-bar");
  const fmt = formatter();
  let label;
  let monthly;
  let payback = null;
  if (lastPortfolio?.recommended) {
    const r = lastPortfolio.recommended;
    label = r.single ? `One ${OPTION_SHORT[r.stacks[0]]} stack` : r.stacks.map((o) => OPTION_SHORT[o]).join(" + ");
    monthly = r.monthly1;
  } else if (lastResult?.recommended) {
    const best = lastResult.options.find((o) => o.id === lastResult.recommended);
    label = OPTION_SHORT[best.id];
    monthly = best.monthly;
    payback = best.value?.paybackMonths ?? best.value?.paybackAt?.(0) ?? null;
  } else {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $("result-bar-main").textContent = `${label} · ${fmt.money(monthly)}/mo${lastPortfolio ? "" : ` · payback ${payback == null ? "never" : `${payback.toFixed(1)} mo`}`}`;
  const delta = $("result-bar-delta");
  if (previousHeadline && previousHeadline.label === label && Math.abs(monthly - previousHeadline.monthly) > Math.max(0.5, previousHeadline.monthly * 0.001)) {
    const d = monthly - previousHeadline.monthly;
    delta.textContent = `${d > 0 ? "▲" : "▼"} ${fmt.money(Math.abs(d))}/mo`;
    delta.className = `result-bar-delta ${d > 0 ? "is-up" : "is-down"}`;
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => (delta.textContent = ""), 4000);
  } else if (previousHeadline && previousHeadline.label !== label) {
    delta.textContent = "Recommendation changed";
    delta.className = "result-bar-delta is-changed";
    clearTimeout(deltaTimer);
    deltaTimer = setTimeout(() => (delta.textContent = ""), 4000);
  }
  previousHeadline = { label, monthly };
}

const OPTION_SHORT = { A: "SaaS", B: "API", C: "Self-hosted", D: "Hybrid" };

/* ---------- workload tabs ---------- */

// Use cases offered first when adding a workload, skipping ones already used.
const ADD_ORDER = ["data_assistant", "invoice_processing", "ticket_triage", "lead_qualification", "report_generation", "internal_copilot", "content_engine", "stock_report", "chatbot", "voice_agent", "document_processing"];

function renderWorkloadTabs() {
  const box = $("workload-tabs");
  const ws = workloadsOf(state);
  const tabs = ws.map((w, i) => {
    const tab = el("button", { type: "button", role: "tab", class: "wl-tab", "aria-selected": String(i === activeW), id: `wl-tab-${i}` }, `${i + 1}. ${workloadLabel(w, data.usecases)}`);
    tab.addEventListener("click", () => switchWorkload(i));
    const wrap = el("span", { class: "wl-tab-wrap" }, tab);
    if (i > 0) {
      const rm = el("button", { type: "button", class: "wl-remove", "aria-label": `Remove workload ${i + 1}` }, "×");
      rm.addEventListener("click", () => removeWorkload(i));
      wrap.append(rm);
    }
    return wrap;
  });
  const add = el("button", { type: "button", class: "wl-add", disabled: ws.length >= MAX_WORKLOADS || null }, "+ Add workload");
  add.addEventListener("click", addWorkload);
  box.replaceChildren(el("div", { class: "wl-tabs", role: "tablist", "aria-label": "Workloads" }, tabs, add));
  $("workload-help").textContent =
    ws.length > 1
      ? `Editing workload ${activeW + 1}. Use case, volume and value are per workload; country, data rules, team and tax are shared.`
      : `Want AI for more than one thing? Add up to ${MAX_WORKLOADS - 1} more workloads to compare one stack with a mix.`;
}

function switchWorkload(i) {
  activeW = i;
  fillForm();
  compute();
}

function addWorkload() {
  if (state.extraWorkloads.length >= MAX_WORKLOADS - 1) return;
  const used = new Set(workloadsOf(state).map((w) => w.useCase));
  const useCase = ADD_ORDER.find((u) => !used.has(u)) || "chatbot";
  const w = newWorkload(useCase, state, data.usecases);
  roundWorkloadMoney(w);
  state.extraWorkloads.push(w);
  activeW = state.extraWorkloads.length;
  fillForm();
  compute();
  status(`Added workload ${activeW + 1}. Pick its use case and volume.`);
}

function removeWorkload(i) {
  state.extraWorkloads.splice(i - 1, 1);
  activeW = 0;
  fillForm();
  compute();
}

/* ---------- saved scenarios ---------- */

let scenarios = [];
const scenarioResults = new Map(); // cache: scenario index → analysis

function loadScenarios() {
  try {
    const raw = JSON.parse(localStorage.getItem(SCENARIOS_KEY) || "[]");
    if (Array.isArray(raw)) scenarios = raw.slice(0, MAX_SCENARIOS).map((x) => ({ name: String(x.name || "Scenario").slice(0, 40), inputs: sanitize(x.inputs) }));
  } catch {
    scenarios = [];
  }
}

function saveScenarios() {
  scenarioResults.clear();
  try {
    localStorage.setItem(SCENARIOS_KEY, JSON.stringify(scenarios));
  } catch {
    /* ignore: scenarios still work for this visit */
  }
}

function saveCurrentScenario() {
  const input = $("scenario-name");
  const name = input.value.trim() || `Scenario ${scenarios.length + 1}`;
  if (scenarios.length >= MAX_SCENARIOS) scenarios.shift();
  scenarios.push({ name, inputs: structuredClone(state) });
  input.value = "";
  saveScenarios();
  renderScenarios();
  status(`Saved “${name}”. Change the inputs to compare against it.`);
}

function scenarioAnalysis(i) {
  if (!scenarioResults.has(i)) {
    const inp = scenarios[i].inputs;
    scenarioResults.set(i, {
      r: analyze(inp, prices, { curve: false }),
      p: inp.extraWorkloads?.length ? analyzePortfolio(inp, prices, { usecases: data.usecases }) : null,
    });
  }
  return scenarioResults.get(i);
}

/** Side-by-side table: every saved scenario plus the current inputs, amounts in the current currency. */
function renderScenarios() {
  const table = $("compare-table");
  $("compare-empty").hidden = scenarios.length > 0;
  table.replaceChildren();
  if (!scenarios.length || !lastResult) return;
  const fmt = formatter();
  const cols = [
    ...scenarios.map((s, i) => ({ name: s.name, inputs: s.inputs, ...scenarioAnalysis(i), index: i })),
    { name: "Current inputs", inputs: state, r: activeW === 0 ? lastResult : analyze(state, prices, { curve: false }), p: lastPortfolio, index: null },
  ];
  const best = (c) => c.r.options.find((o) => o.id === c.r.recommended);
  const regionName = (code) => data.regions.regions.find((r) => r.code === code)?.name || code;
  const money = (x) => (x == null || !Number.isFinite(x) ? "—" : fmt.money(x));
  const rows = [
    ["Country · currency entered", (c) => `${regionName(c.inputs.region)} · ${c.inputs.displayCurrency}`],
    ["LLM requests (month 1)", (c) => `${fmt.number(c.p ? c.p.workloads.reduce((s, w) => s + volume(w, 0).requestsPerMonth, 0) : c.r.volume.requestsPerMonth)}${c.p ? " (all workloads)" : ""}`],
    ["Workloads", (c) => (c.p ? c.p.names.join(" + ") : workloadLabel(c.inputs, data.usecases))],
    ["Recommended", (c) => (c.p ? (c.p.recommended ? describeCombo(c.p.recommended, c.p.names) : "None viable") : best(c)?.label ?? "None viable")],
    ["Monthly cost (month 1)", (c) => money(c.p ? c.p.recommended?.monthly1 : best(c)?.monthly)],
    ["One-time build", (c) => money(c.p ? c.p.recommended?.oneTime : best(c)?.oneTime)],
    ["36-month TCO", (c) => money(c.p ? c.p.recommended?.tco36 : best(c)?.tco36)],
    ["36-month TCO, no growth", (c) => (c.p ? "—" : money(best(c)?.tco36NoGrowth))],
    ["Extra sales/month to break even", (c) => {
      if (c.p) return "—";
      const v = best(c)?.value;
      return v && Number.isFinite(v.salesNeeded) ? fmt.number(v.salesNeeded) : "—";
    }],
    ["Time saved (agents)", (c) => {
      if (c.p) {
        const agents = c.p.detail.perWorkload.filter((w) => w.agent);
        if (!agents.length) return "—";
        const hours = agents.reduce((s, w) => s + w.value.netHours, 0);
        const fte = agents.reduce((s, w) => s + w.value.fte, 0);
        return c.inputs.valueUnit === "fte" ? `${fmt.number(fte, 2)} FTE` : `${fmt.number(Math.round(hours))} hours/month`;
      }
      const v = best(c)?.value;
      if (v?.kind !== "agent") return "—";
      return c.inputs.valueUnit === "fte" ? `${fmt.number(v.fte, 2)} FTE` : `${fmt.number(Math.round(v.netHours))} hours/month`;
    }],
    ["Payback of build cost", (c) => {
      if (c.p) return "—";
      const p = best(c)?.value?.paybackAt(0);
      return p == null ? "Never" : `${p.toFixed(1)} months`;
    }],
    ["Decision", (c) => (c.p ? (c.p.bestSingle === c.p.recommended ? "Single stack" : "Mix") : c.r.robustness.robust ? "Robust" : `Close call (${c.r.robustness.flips[0].label.toLowerCase()})`)],
  ];
  const thead = el("thead", {}, el("tr", {}, el("th", { scope: "col" }, ""), cols.map((c) => el("th", { scope: "col" }, c.name))));
  const tbody = el("tbody", {}, rows.map(([label, fn]) => el("tr", {}, el("th", { scope: "row" }, label), cols.map((c) => el("td", {}, fn(c))))));
  const actions = el("tr", { class: "no-print" }, el("th", { scope: "row" }, ""), cols.map((c) => {
    if (c.index == null) return el("td", {}, "");
    const load = el("button", { type: "button", class: "btn-link" }, "Load");
    load.addEventListener("click", () => {
      state = sanitize(structuredClone(scenarios[c.index].inputs));
      activeW = 0;
      resetWeights();
      fillForm();
      compute();
      status(`Loaded “${scenarios[c.index].name}”.`);
    });
    const remove = el("button", { type: "button", class: "btn-link" }, "Remove");
    remove.addEventListener("click", () => {
      scenarios.splice(c.index, 1);
      saveScenarios();
      renderScenarios();
    });
    return el("td", {}, load, remove);
  }));
  tbody.append(actions);
  table.append(thead, tbody);
}

function lawNoteFor(s) {
  const regions = data.regions.regions;
  const byResidency = regions.find((r) => r.residency === s.residency);
  const own = regions.find((r) => r.code === s.region);
  const notes = new Set([own?.data_protection_note, byResidency?.data_protection_note].filter(Boolean));
  return [...notes].join("; ");
}

/* ---------- weight sliders ---------- */

function renderWeights() {
  const box = $("weights");
  if (box.childElementCount) {
    // keep sliders (and focus) in place; just refresh the auto cost-weight label
    $("w-cost-out").textContent = costWeightLabel();
    return;
  }
  for (const c of CRITERIA) box.append(slider(`w-${c.id}`, c.label, state.weights[c.id], (v) => (state.weights[c.id] = v)));
  box.append(slider("w-cost", "Cost vs non-cost weight", Math.round(lastResult.costWeight * 100), (v) => (state.costWeightPct = v), costWeightLabel));
}

function costWeightLabel() {
  return state.costWeightPct == null ? `${Math.round((lastResult?.costWeight ?? 0.5) * 100)}% (auto)` : `${state.costWeightPct}%`;
}

function slider(id, label, value, onChange, labelFn) {
  const input = el("input", { type: "range", id, min: "0", max: "100", step: "5", value: String(value) });
  const out = el("output", { id: `${id}-out`, for: id }, labelFn ? labelFn() : `${value}`);
  input.addEventListener("input", () => {
    onChange(Number(input.value));
    out.textContent = labelFn ? labelFn() : input.value;
    scheduleCompute();
  });
  return el("label", { for: id }, el("span", {}, label, ": ", out), input);
}

function resetWeights() {
  $("weights").replaceChildren();
}

/* ---------- sharing, export, storage ---------- */

function encodeState(s) {
  const bytes = new TextEncoder().encode(JSON.stringify(s));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeState(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Only accept known keys with the right types from a shared link or storage. */
/** Copies values whose type matches the default (numbers may be null where the default is null). */
function copyTyped(out, obj, keys) {
  for (const k of keys) {
    const def = DEFAULT_INPUTS[k];
    const v = obj[k];
    if (v === undefined) continue;
    if (def === null) {
      if (v === null || typeof v === "number") out[k] = v;
    } else if (typeof v === typeof def && (typeof v !== "object" || v === null)) out[k] = typeof v === "string" ? v.slice(0, 80) : v;
  }
  return out;
}

function sanitize(obj) {
  const out = withDefaults();
  if (!obj || typeof obj !== "object") return out;
  for (const [k, def] of Object.entries(DEFAULT_INPUTS)) {
    const v = obj[k];
    if (v === undefined) continue;
    if (k === "uncertainKeys") {
      out.uncertainKeys = Array.isArray(v) ? [...new Set(v.filter((x) => RANGE_KEYS.includes(x)))] : [];
      continue;
    }
    if (k === "extraWorkloads") {
      out.extraWorkloads = Array.isArray(v) ? v.slice(0, MAX_WORKLOADS - 1).map((w) => copyTyped(pickWorkload(withDefaults()), w || {}, WORKLOAD_KEYS)) : [];
      continue;
    }
    if (def && typeof def === "object") {
      for (const sub of Object.keys(def)) if (typeof v?.[sub] === "number") out[k][sub] = v[sub];
    } else if (def === null) {
      if (v === null || typeof v === "number") out[k] = v;
    } else if (typeof v === typeof def) out[k] = typeof v === "string" ? v.slice(0, 80) : v;
  }
  return out;
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage blocked: the app still works */
  }
}

function loadInitialState() {
  const m = location.hash.match(/^#s=([A-Za-z0-9_-]+)$/);
  if (m) {
    try {
      return sanitize(decodeState(m[1]));
    } catch {
      /* broken link: fall through */
    }
  }
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return sanitize(JSON.parse(saved));
  } catch {
    /* ignore */
  }
  return null;
}

function status(text) {
  $("action-status").textContent = text;
}

async function copyShareLink() {
  const url = `${location.origin}${location.pathname}#s=${encodeState(state)}`;
  history.replaceState(null, "", `#s=${encodeState(state)}`);
  try {
    await navigator.clipboard.writeText(url);
    status("Link copied. Anyone with it sees this scenario; nothing is stored on a server.");
  } catch {
    status("Link is in the address bar. Copy it from there.");
  }
}

function downloadJson() {
  if (!lastResult) return;
  const { curve, ...rest } = lastResult;
  const payload = {
    generated_at: new Date().toISOString(),
    tool: "AI Stack Advisor",
    note: "All money values are USD. Estimates only.",
    inputs: state,
    saved_scenarios: scenarios,
    exchange_rates: data.fx,
    results: { ...rest, cost_curve: curve },
    portfolio: lastPortfolio,
    ranges: lastRange && { uncertain_inputs: lastRange.keys, cases: lastRange.cases },
    simulation: lastSim && { runs: lastSim.runs, win_share: lastSim.winShare, monthly: lastSim.monthly, net_monthly_benefit: lastSim.net, pv36: lastSim.pv36, prob_net_positive: lastSim.probNetPositive, varied: lastSim.factors.map((f) => f.id) },
    sensitivity: lastTornado?.rows,
    assumption_register: currentRegister().filter((e) => e.kind !== "price" || (lastResult?.pricesUsed || []).some((p) => p.id === e.priceId)),
  };
  const blob = new Blob([JSON.stringify(payload, (k, v) => (typeof v === "function" ? undefined : v === Infinity ? null : v), 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `ai-stack-advisor-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
  status("JSON downloaded.");
}

/* ---------- theme ---------- */

function setupTheme() {
  const btn = $("theme-toggle");
  const current = () => document.documentElement.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const label = () => (btn.textContent = current() === "dark" ? "Light mode" : "Dark mode");
  label();
  btn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("asa-theme", next);
    } catch {
      /* ignore */
    }
    label();
    render(); // charts read colours from CSS variables
  });
}

/* ---------- start ---------- */

/** Defaults for a first visit: country guessed from the browser language, preset in that currency. */
function freshState() {
  state = withDefaults();
  const d = regionDefaults(regionFromLocales(navigator.languages || [navigator.language], data.regions), data.regions);
  Object.assign(state, { region: d.region, residency: d.residency, displayCurrency: d.displayCurrency, taxVariant: data.taxes.regions[d.region]?.default_variant ?? "" });
  applyPreset(state.industry);
  state.engineerHourlyUsd = moneyDefaults().engineerHourlyUsd;
  state.staffHourlyUsd = moneyDefaults().staffHourlyUsd;
  state.fteHoursPerMonth = d.fteHoursPerMonth;
  return state;
}

async function loadJson(name) {
  const res = await fetch(`./data/${name}`);
  if (!res.ok) throw new Error(`Could not load data/${name}`);
  return res.json();
}

async function init() {
  setupTheme();
  const [pricesData, fx, regions, presets, usecases, selfhost, taxes, assumptions, labour, tokens] = await Promise.all(
    ["prices.json", "fx.json", "regions.json", "presets.json", "usecases.json", "selfhost.json", "taxes.json", "assumptions.json", "labour.json", "token-measurements.json"].map(loadJson),
  );
  data = { fx, regions, presets, usecases, selfhost, taxes, prices: pricesData, assumptions, labour, tokens };
  prices = indexPrices(pricesData, fx, selfhost, taxes);

  const currencies = Object.keys(fx.rates);
  const names = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "currency" }) : null;
  const currencyLabel = (c) => (names ? `${c} · ${names.of(c)}` : c);
  for (const r of regions.regions) $("setup-region").append(el("option", { value: r.code }, r.name));
  for (const c of currencies) $("setup-currency").append(el("option", { value: c }, currencyLabel(c)));
  $("compare-currency").append(el("option", { value: "" }, "None"));
  for (const c of currencies) $("compare-currency").append(el("option", { value: c }, c));

  state = loadInitialState() || freshState();

  buildForm();
  fillForm();
  let savedMode = "quick";
  try {
    savedMode = localStorage.getItem(MODE_KEY) || "quick";
  } catch {
    /* ignore */
  }
  setMode(savedMode);
  $("mode-quick").addEventListener("click", () => setMode("quick"));
  $("mode-full").addEventListener("click", () => setMode("full"));
  addHeadingInfo();
  let savedView = "exec";
  try {
    savedView = localStorage.getItem(VIEW_KEY) || "exec";
  } catch {
    /* ignore */
  }
  setView(savedView);
  $("view-exec").addEventListener("click", () => setView("exec"));
  $("view-analyst").addEventListener("click", () => setView("analyst"));
  // Show the result bar only while the summary itself is off-screen.
  if ("IntersectionObserver" in window) {
    const seen = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target) : seen.delete(e.target);
      document.body.classList.toggle("summary-in-view", seen.size > 0);
    });
    io.observe(document.querySelector(".summary"));
    io.observe($("portfolio-card"));
  }
  $("result-bar-btn").addEventListener("click", () => {
    const target = lastPortfolio ? $("portfolio-card") : $("results");
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    target.focus?.({ preventScroll: true });
  });
  loadScenarios();
  $("save-scenario").addEventListener("click", saveCurrentScenario);
  $("scenario-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveCurrentScenario();
  });

  $("setup-region").addEventListener("change", (e) => {
    applyRegion(e.target.value); // keeps the user's inputs; money is converted and rounded
    fillForm();
    compute();
  });
  $("setup-currency").addEventListener("change", (e) => {
    setCurrency(e.target.value);
    fillForm(); // money inputs now show amounts in the new currency
    compute();
  });
  $("compare-currency").addEventListener("change", (e) => {
    state.compareCurrency = e.target.value;
    render();
    persist();
  });
  $("number-format").addEventListener("change", (e) => {
    state.numberFormat = e.target.value;
    render();
    persist();
  });
  $("reset-btn").addEventListener("click", () => {
    activeW = 0;
    state = freshState();
    history.replaceState(null, "", location.pathname);
    resetWeights();
    fillForm();
    compute();
  });
  $("print-btn").addEventListener("click", () => window.print());
  $("share-btn").addEventListener("click", copyShareLink);
  $("json-btn").addEventListener("click", downloadJson);

  // Print: open the chart data tables so the PDF includes them
  window.addEventListener("beforeprint", () => document.querySelectorAll("details.alt-table").forEach((d) => (d.dataset.wasOpen = d.open, (d.open = true))));
  window.addEventListener("afterprint", () => document.querySelectorAll("details.alt-table").forEach((d) => (d.open = d.dataset.wasOpen === "true")));
  window.addEventListener("hashchange", () => {
    const s = loadInitialState();
    if (s) {
      state = s;
      activeW = 0;
      resetWeights();
      fillForm();
      compute();
    }
  });

  // Chart.js loads with `defer`; render once it is available.
  if (!window.Chart) window.addEventListener("load", render, { once: true });
  compute();
}

init().catch((err) => {
  const box = $("error-box");
  box.textContent = `Could not start: ${err.message}. Serve the folder over http (e.g. "python -m http.server") rather than opening the file directly.`;
  box.hidden = false;
});
