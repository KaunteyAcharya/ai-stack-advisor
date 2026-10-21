// Plain-language helpers for the form: goal cards, a short glossary, and live hints that
// translate inputs into everyday terms ("≈ 2,00,040 requests a month", "≈ 1,100 words").

/** Goal cards for "What do you want AI to do?". Each card is one use case (one workload). */
export const GOAL_GROUPS = ["Talk to customers", "Help your team", "Automate work"];

export const GOALS = [
  { id: "chatbot", group: "Talk to customers", title: "Chatbots", desc: "Website or WhatsApp assistant for questions, orders, bookings and leads." },
  { id: "voice_agent", group: "Talk to customers", title: "Voice AI agents", desc: "Answer phone calls, book appointments and route callers, day and night." },
  { id: "data_assistant", group: "Help your team", title: "Data assistants", desc: "Ask questions about sales, stock or reports in plain language." },
  { id: "internal_copilot", group: "Help your team", title: "Team copilots", desc: "Drafts, summaries, emails and research for your staff." },
  { id: "document_processing", group: "Help your team", title: "Document AI", desc: "Pull key facts out of contracts, forms and PDFs." },
  { id: "invoice_processing", group: "Automate work", title: "Invoice processing agents", desc: "Read invoices and enter them into your accounting system." },
  { id: "lead_qualification", group: "Automate work", title: "Lead qualification agents", desc: "Research, score and route new leads before sales calls." },
  { id: "ticket_triage", group: "Automate work", title: "Ticket triage agents", desc: "Tag, prioritise and route support tickets to the right team." },
  { id: "report_generation", group: "Automate work", title: "Report generation agents", desc: "Turn your data into weekly or monthly reports." },
  { id: "stock_report", group: "Automate work", title: "Market data report agents", desc: "Stock and market updates written from a data feed." },
  { id: "content_engine", group: "Automate work", title: "AI content engines", desc: "Create videos, images and posts, publish them, and reply to comments on your own posts." },
];

/** One-line definitions for jargon, shown behind an ⓘ button. */
export const GLOSSARY = {
  tokens: "Tokens are the pieces of text an AI model reads and writes. About 4 tokens make 3 English words. Providers charge per million tokens.",
  tco: "Total cost of ownership: the one-time build cost plus every monthly cost over the period (12 or 36 months).",
  rag: "Retrieval-augmented generation: the AI looks up your own documents or knowledge base before answering. It needs a vector database.",
  deflection: "The share of conversations the AI resolves completely, so no person needs to step in.",
  batch: "Batch processing: the provider runs requests within a few hours instead of instantly, for about half the price.",
  fte: "Full-time equivalent: the work of one person working full time (here, the working hours per month you set).",
  hybrid: "Hybrid: routine requests run on your own rented GPUs; harder ones go to a hosted AI API.",
  peak: "Share of a day's traffic that arrives in the busiest hour. Self-hosted GPUs must be sized for that hour.",
  conversion: "The share of conversations or leads that end in a sale.",
  devops: "DevOps / MLOps: the skills to run servers and AI models yourself: deployment, monitoring, updates and on-call support.",
  residency: "Data residency: a rule that data must be stored or processed inside a given country or region.",
  context: "Each step of an agent re-reads everything produced so far, so later steps cost more than earlier ones.",
  external: "External AI providers are companies like Google, OpenAI or Anthropic whose hosted models you call through an API.",
  workload: "A workload is one thing you want AI to do. Pick as many as you need; the tool compares running them on one stack or a mix.",
  payback: "How many months of net benefit it takes to earn back the one-time build cost.",
  matrix: "Scores each option from 0 to 5 on privacy, time to launch, team fit, quality, lock-in and scalability, weighted by your priorities.",
  breakeven: "The volume at which two options cost the same. Above it, the option with the lower cost per request is cheaper.",
  register: "Every number behind the result, with its source and how far to trust it: verified (official or primary source), benchmark (an official statistic used as a proxy) or estimate (a judgement to replace with your own figure).",
  gap: "How much worse an open-weight model does on your task than a frontier API model, in percentage points of tasks completed. It varies a lot by task, so test it on your own data.",
  pv: "Present value: future costs discounted to today's money, because spending later is cheaper than spending now.",
  caching: "Prompt caching: when the start of a prompt repeats (system prompt, instructions, earlier steps), the provider can reuse it and charges far less for those tokens.",
  simulation: "The analysis is re-run hundreds of times with prices, labour, GPU speed, the quality gap and your 'not sure' inputs drawn from realistic ranges. The result shows how often each option wins.",
  tornado: "Each assumption is moved to its low and high end on its own. The longest bars are the assumptions that matter most, so check those first.",
};

/** Which glossary entry each input links to. */
export const FIELD_TERMS = {
  inTokens: "tokens",
  outTokens: "tokens",
  inTokensPerStep: "tokens",
  outTokensPerStep: "tokens",
  tokensPerPage: "tokens",
  docOutTokens: "tokens",
  replyInTokens: "tokens",
  replyOutTokens: "tokens",
  contextGrowthPerStep: "context",
  rag: "rag",
  cachedSharePct: "caching",
  openModelGapPct: "gap",
  discountRatePct: "pv",
  deflectionPct: "deflection",
  useBatch: "batch",
  fteHoursPerMonth: "fte",
  valueUnit: "fte",
  shareSelfPct: "hybrid",
  peakSharePct: "peak",
  conversionPct: "conversion",
  devops: "devops",
  residency: "residency",
  externalAllowed: "external",
};

const words = (tokens) => Math.round((tokens * 3) / 4);

/**
 * Live hints. Each takes (s = the active workload's inputs, c = { n(number, decimals), money(usd), vol, unit })
 * and returns a short sentence, or null to show nothing.
 */
export const HINTS = {
  usersPerDay: (s, c) => `≈ ${c.n(c.vol.requestsPerMonth)} requests and ${c.n(c.vol.conversationsPerMonth)} conversations a month`,
  requestsPerUser: (s, c) => `≈ ${c.n(s.usersPerDay * s.requestsPerUser)} messages a day in total`,
  inTokens: (s, c) => `≈ ${c.n(words(s.inTokens))} words read per request (question plus context)`,
  outTokens: (s, c) => `≈ ${c.n(words(s.outTokens))} words written per reply`,
  inTokensPerStep: (s, c) => `≈ ${c.n(words(s.inTokensPerStep))} words read at the first step`,
  outTokensPerStep: (s, c) => `≈ ${c.n(words(s.outTokensPerStep))} words written per step`,
  contextGrowthPerStep: (s, c) => `Average input per call ≈ ${c.n(s.inTokensPerStep + (s.contextGrowthPerStep * (Math.max(1, s.stepsPerTask) - 1)) / 2)} tokens`,
  stepsPerTask: (s, c) => `${c.n(c.vol.requestsPerMonth)} AI calls a month (${c.unit} × steps)`,
  tokensPerPage: (s, c) => `≈ ${c.n(words(s.tokensPerPage))} words per page`,
  docsPerMonth: (s, c) => `≈ ${c.n(s.docsPerMonth * s.pagesPerDoc)} pages a month`,
  pagesPerDoc: (s, c) => `≈ ${c.n(s.docsPerMonth * s.pagesPerDoc)} pages a month`,
  tasksPerMonth: (s, c) => `≈ ${c.n(s.tasksPerMonth / 22, 1)} ${c.unit} per working day`,
  successPct: (s, c) => `${c.n((s.tasksPerMonth * s.successPct) / 100)} of ${c.n(s.tasksPerMonth)} ${c.unit} a month done without a person`,
  reviewPct: (s, c) => `${c.n((s.tasksPerMonth * s.reviewPct) / 100)} ${c.unit} a month checked by a person`,
  errorPct: (s, c) => `≈ ${c.n((s.tasksPerMonth * s.errorPct) / 100, 1)} mistakes a month slip through`,
  humanMinutesPerTask: (s, c) => `≈ ${c.n((s.tasksPerMonth * s.humanMinutesPerTask) / 60)} hours of manual work a month today`,
  minutesSavedPerRequest: (s, c) => `≈ ${c.n((c.vol.requestsPerMonth * s.minutesSavedPerRequest) / 60)} staff hours a month across ${c.n(c.vol.requestsPerMonth)} requests`,
  staffHourlyUsd: (s, c) => `≈ ${c.money(s.staffHourlyUsd * s.fteHoursPerMonth)} a month for one full-time person`,
  growthPct: (s, c) => {
    const months = Math.min(s.growthMonths ?? 36, 36);
    return s.growthPct > 0 ? `Volume × ${c.n(Math.pow(1 + s.growthPct / 100, months), 1)} after ${c.n(months)} months, then flat` : "Volume stays the same every month";
  },
  growthMonths: (s, c) => (s.growthPct > 0 ? `Growth stops after month ${c.n(s.growthMonths)}` : null),
  peakSharePct: (s, c) => `Busiest hour ≈ ${c.n((c.vol.requestsPerMonth / 30) * (s.peakSharePct / 100))} requests`,
  conversionPct: (s, c) => `≈ ${c.n((c.vol.conversationsPerMonth * s.conversionPct) / 100)} sales a month from ${c.n(c.vol.conversationsPerMonth)} conversations`,
  humanSharePct: (s, c) => `≈ ${c.n((c.vol.conversationsPerMonth * s.humanSharePct) / 100)} conversations a month reach a person today`,
  deflectionPct: (s, c) => `AI fully handles ≈ ${c.n((c.vol.conversationsPerMonth * (s.humanSharePct / 100) * s.deflectionPct) / 100)} of those a month`,
  videosPerMonth: (s, c) => `≈ ${c.n((s.videosPerMonth * s.secondsPerVideo) / 60, 1)} minutes of video a month`,
  secondsPerVideo: (s, c) => `≈ ${c.n((s.videosPerMonth * s.secondsPerVideo) / 60, 1)} minutes of video a month`,
  repliesPerMonth: (s, c) => `≈ ${c.n(s.repliesPerMonth / 30, 1)} replies a day`,
  ticketUsd: (s, c) => `Gross profit per sale ≈ ${c.money((s.ticketUsd * s.marginPct) / 100)}`,
  marginPct: (s, c) => `Gross profit per sale ≈ ${c.money((s.ticketUsd * s.marginPct) / 100)}`,
  cachedSharePct: (s, c) => {
    if (!(s.cachedSharePct > 0) || !c.cacheMin) return null;
    const avg = Math.round(c.vol.avgInTokens);
    return avg >= c.cacheMin ? `Applies: prompts average ${c.n(avg)} tokens (minimum ${c.n(c.cacheMin)})` : `Not applied: prompts average ${c.n(avg)} tokens, below the ${c.n(c.cacheMin)}-token minimum`;
  },
  seats: (s) => (["data_assistant", "internal_copilot"].includes(s.useCase) ? "Per-seat plans charge at least one seat for each daily user" : null),
};
