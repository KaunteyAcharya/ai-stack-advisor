// Non-cost decision matrix. Scores are 0–5 per criterion; weights are user-adjustable.

import { OPTION_IDS } from "./inputs.js";

export const CRITERIA = [
  { id: "privacy", label: "Data privacy & compliance fit" },
  { id: "timeToLaunch", label: "Time to launch" },
  { id: "teamFit", label: "Team capability fit" },
  { id: "quality", label: "Quality fit" },
  { id: "lockIn", label: "Vendor lock-in (higher = less lock-in)" },
  { id: "scalability", label: "Scalability" },
];

/** Starting scores before any rules apply, each with a one-line reason (exported to METHODOLOGY.md). */
export const BASE_SCORES = {
  privacy: {
    A: [2, "Data sits with a third-party vendor under its standard terms."],
    B: [3, "Data goes to an API provider, but you control storage and prompts."],
    C: [5, "Data never leaves infrastructure you control."],
    D: [4, "Most traffic stays in-house; complex requests go to an API."],
  },
  timeToLaunch: {
    A: [5, "Configure and launch in days."],
    B: [4, "A few weeks of integration work."],
    C: [2, "GPU setup, model serving and evaluation take months."],
    D: [1, "Needs both the API build and the self-hosted stack, plus routing."],
  },
  teamFit: {
    A: [5, "Needs almost no engineering."],
    B: [4, "Needs at least one developer."],
    C: [3, "Needs DevOps/MLOps skills to run GPUs."],
    D: [3, "Needs DevOps/MLOps skills plus API integration."],
  },
  quality: {
    A: [4, "Good vendor models, limited customisation."],
    B: [5, "Direct access to frontier models."],
    C: [4, "Open models are good for routine tasks."],
    D: [4, "Frontier models for hard requests, open models for routine ones."],
  },
  lockIn: {
    A: [1, "Workflows, data and pricing tied to one vendor."],
    B: [3, "Prompts are portable, but the code targets one provider's API."],
    C: [5, "Open weights; you can move providers any time."],
    D: [4, "Mostly portable; the API part can be swapped."],
  },
  scalability: {
    A: [3, "Scales, but cost rises with volume and plan limits."],
    B: [5, "Provider scales automatically."],
    C: [3, "You add GPUs yourself as traffic grows."],
    D: [4, "API absorbs peaks above self-hosted capacity."],
  },
};

/**
 * Every rule in one table. `when` reads the inputs; `then` lists score changes
 * (`set` replaces, `add` adjusts), exclusions and notes. Scores are clamped to 0–5.
 */
export const RULES = [
  {
    id: "data_must_stay",
    why: "SaaS and API send data outside the company, which the requirement forbids.",
    when: (i) => i.externalAllowed === "no",
    exclude: { A: "Data may not leave company infrastructure", B: "Data may not leave company infrastructure" },
    notes: { D: "Hybrid limited to its self-hosted share, because data may not leave company infrastructure." },
  },
  {
    id: "no_training_only",
    why: "Only paid tiers with no-training terms are allowed, which narrows vendor choice.",
    when: (i) => i.externalAllowed === "only_no_training",
    add: { privacy: { A: -1, B: -1 } },
    notes: {
      A: "Use a paid plan whose terms exclude training on customer data.",
      B: "Use a paid API tier whose terms exclude training on customer data.",
    },
  },
  {
    id: "personal_data_external",
    why: "Personal data at an external provider adds compliance work.",
    when: (i) => i.personalData && i.externalAllowed === "yes",
    add: { privacy: { A: -1, B: -1 } },
    notes: { B: "Personal data will reach an external AI provider; check its data-processing terms." },
  },
  {
    id: "residency_required",
    why: "External vendors may not offer processing in the required region.",
    when: (i) => i.residency && i.residency !== "none" && i.externalAllowed !== "no",
    add: { privacy: { A: -1, B: -1 } },
    notes: {
      A: "Check that the SaaS vendor can store data in the required region.",
      B: "Check that the API provider offers processing in the required region.",
    },
  },
  {
    id: "no_engineers",
    why: "Custom builds need engineers the company does not have.",
    when: (i) => i.engineers === "none",
    set: { teamFit: { B: 1, C: 0, D: 0 } },
    warnings: { B: "No in-house engineers: a custom API build needs a contractor or agency.", C: "No in-house engineers to run self-hosted infrastructure.", D: "No in-house engineers to run a hybrid setup." },
  },
  {
    id: "small_team",
    why: "A small team handles an API build comfortably.",
    when: (i) => i.engineers === "small_team",
    set: { teamFit: { B: 5 } },
  },
  {
    id: "no_devops",
    why: "Running GPUs without DevOps/MLOps skills is high-risk.",
    when: (i) => i.devops === "none",
    set: { teamFit: { C: 1, D: 1 } },
    warnings: { C: "No DevOps/MLOps capability: self-hosting GPUs is high-risk for this team.", D: "No DevOps/MLOps capability: the self-hosted half of a hybrid is high-risk." },
  },
  {
    id: "strong_devops",
    why: "Strong DevOps makes self-hosting a good team fit.",
    when: (i) => i.devops === "strong" && i.engineers !== "none",
    set: { teamFit: { C: 5, D: 4 } },
  },
  {
    id: "best_quality",
    why: "Open models may trail frontier models when the best quality is needed.",
    when: (i) => i.quality === "best_available",
    set: { quality: { C: 2, D: 3 } },
    notes: { C: "Open models may lag frontier models; test on your own task before committing." },
  },
  {
    id: "open_model_gap",
    why: "Open models may trail frontier models; worth testing before committing.",
    when: (i) => i.quality === "good",
    notes: { C: "Open-weight models may trail frontier models on some tasks; evaluate on your own data." },
  },
  {
    id: "basic_quality",
    why: "Open models are fully adequate for basic quality needs.",
    when: (i) => i.quality === "basic",
    set: { quality: { C: 5, D: 5 } },
  },
  {
    id: "realtime_voice",
    why: "Real-time voice on a small GPU pool risks latency at peak.",
    when: (i) => i.latency === "realtime" && i.useCase === "voice_agent",
    add: { scalability: { C: -1 } },
    notes: { C: "Real-time voice on a small GPU pool risks latency spikes at peak." },
  },
  {
    id: "ha_without_devops",
    why: "High availability needs on-call operations.",
    when: (i) => i.uptime === "high_availability" && i.devops !== "strong",
    add: { scalability: { C: -1, D: -1 } },
    notes: { C: "High availability needs on-call operations; plan for it." },
  },
];

export function scoreOptions(inputs) {
  const scores = Object.fromEntries(Object.entries(BASE_SCORES).map(([c, byOpt]) => [c, Object.fromEntries(Object.entries(byOpt).map(([o, [v]]) => [o, v]))]));
  const excluded = {};
  const notes = Object.fromEntries(OPTION_IDS.map((id) => [id, []]));
  const warnings = Object.fromEntries(OPTION_IDS.map((id) => [id, []]));

  for (const rule of RULES) {
    if (!rule.when(inputs)) continue;
    for (const [crit, byOpt] of Object.entries(rule.set || {})) Object.assign(scores[crit], byOpt);
    for (const [crit, byOpt] of Object.entries(rule.add || {})) {
      for (const [opt, d] of Object.entries(byOpt)) scores[crit][opt] += d;
    }
    for (const [opt, reason] of Object.entries(rule.exclude || {})) excluded[opt] = reason;
    for (const [opt, n] of Object.entries(rule.notes || {})) notes[opt].push(n);
    for (const [opt, w] of Object.entries(rule.warnings || {})) warnings[opt].push(w);
  }
  for (const crit of Object.keys(scores)) {
    for (const opt of OPTION_IDS) scores[crit][opt] = Math.max(0, Math.min(5, scores[crit][opt]));
  }
  return { scores, excluded, notes, warnings };
}

/** Weighted non-cost score in 0–1: Σ(weight × score) / (5 × Σ weight). */
export function weightedScore(scores, weights, option) {
  let num = 0;
  let den = 0;
  for (const { id } of CRITERIA) {
    const w = weights[id] ?? 0;
    num += w * scores[id][option];
    den += w * 5;
  }
  return den > 0 ? num / den : 0;
}
