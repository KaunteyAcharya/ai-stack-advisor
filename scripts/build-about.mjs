// Builds the method and reference-data sections of about.html from docs/METHODOLOGY.md and the
// data/*.json files, so the public page always carries every formula, assumption and price.
// Usage: node scripts/build-about.mjs --write   (updates about.html between the GEN markers)
//        node scripts/build-about.mjs           (exit 1 if about.html is out of date)
// A test fails if about.html drifts out of sync with the methodology or the data.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// KaTeX (MIT licence, scripts/vendor) turns the LaTeX in ```math blocks into MathML when the page is
// built. Browsers draw MathML themselves, so the published page loads no maths script or font.
const katex = createRequire(import.meta.url)("./vendor/katex.min.cjs");

const ROOT = new URL("../", import.meta.url);
const REPO = "https://github.com/KaunteyAcharya/ai-stack-advisor";
export const PAGE_URL = "https://kaunteyacharya.com/ai-stack-advisor/about.html";
const read = (p) => readFileSync(new URL(p, ROOT), "utf8");
const json = (p) => JSON.parse(read(p));

// ---------- small helpers ----------

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const longDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const shortDate = (iso) => (iso ? longDate(iso).replace(/(\d+ \w{3})\w* /, "$1 ") : "—");
const usd = (x, dp) => {
  if (x == null) return "—";
  const d = dp ?? (x === 0 ? 0 : Math.abs(x) < 0.1 ? 4 : Number.isInteger(x) ? 0 : 2);
  return "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const num = (x) => (x == null ? "—" : x.toLocaleString("en-US"));
const pct = (x) => (x == null ? "—" : `${x}%`);
const sourceLink = (url, text = "source") => (/^https:\/\//.test(url || "") ? `<a href="${esc(url)}" rel="noopener">${esc(text)}</a>` : "—");
const confidence = (c) => `<span class="conf conf-${esc(c)}">${esc(c)}</span>`;

function table(head, rows, { numCols = [] } = {}) {
  const cls = (i) => (numCols.includes(i) ? ' class="num"' : "");
  return [
    '<div class="table-wrap"><table class="data">',
    `<thead><tr>${head.map((h, i) => `<th scope="col"${cls(i)}>${h}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    ...rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`),
    "</tbody></table></div>",
  ].join("\n");
}

// ---------- Markdown → HTML (only what METHODOLOGY.md uses) ----------

const sectionId = (text) => {
  const n = text.match(/^(\d+[a-z]?)\.\s/);
  return n ? `method-${n[1]}` : "method-" + text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
};

function repoUrl(href) {
  if (/^(https?:|#|mailto:)/.test(href)) return href;
  const path = new URL(href, "https://x/docs/").pathname.slice(1).replace(/\/$/, "");
  return `${REPO}/${/\.\w+$/.test(path) ? "blob" : "tree"}/main/${path}`;
}

export function inline(md) {
  const codes = [];
  let s = md.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${esc(repoUrl(h.replace(/&amp;/g, "&")))}"${/^#/.test(h) ? "" : ' rel="noopener"'}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    // "section 4", "sections 10 and 12": link to the section on this page
    .replace(/\b(section) (\d+[a-e]?)\b/gi, (m, w, n) => `<a href="#method-${n}">${w} ${n}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

/** One display formula as MathML, in a box that scrolls sideways when the formula is wider than the screen. */
export function mathHtml(tex) {
  const ml = katex.renderToString(tex, { displayMode: true, output: "mathml", throwOnError: true, strict: "error" });
  return `<div class="formula math">${ml.replace(/^<span class="katex">/, "").replace(/<\/span>$/, "")}</div>`;
}

/** Converts METHODOLOGY.md to HTML. Returns { html, toc } (toc = top-level sections). */
export function methodHtml(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const toc = [];
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(/^```math/.test(line) ? mathHtml(code.join("\n")) : `<pre class="formula"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) {
      flush();
      i++;
      if (h[1] === "#") continue; // the page has its own H1
      // A trailing "(`engine/x.js` → `fn`)" names the code; show it as a small label.
      const m = h[2].match(/\s*\((`[^)]*`)\)/);
      const title = m ? h[2].replace(m[0], "") : h[2];
      const code = m ? ` <span class="code-ref">${inline(m[1])}</span>` : "";
      const id = sectionId(title);
      const level = h[1] === "##" ? 2 : 3;
      if (level === 2) toc.push({ id, title });
      out.push(`<h${level} id="${id}">${inline(title)}${code}</h${level}>`);
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      out.push(table(head.map(inline), rows.map((r) => r.map(inline))));
      continue;
    }
    if (/^- /.test(line)) {
      flush();
      const items = [];
      for (; i < lines.length && /^- /.test(lines[i]); i++) items.push(`<li>${inline(lines[i].slice(2))}</li>`);
      out.push(`<ul>\n${items.join("\n")}\n</ul>`);
      continue;
    }
    if (/^\s*$/.test(line) || /^---+$/.test(line) || /^<!--.*-->$/.test(line.trim())) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return { html: out.join("\n"), toc };
}

// ---------- Reference data ----------

function priceText(e) {
  switch (e.pricing_type) {
    case "per_seat":
      return `${usd(e.per_seat_price)}/seat/month${e.per_seat_price_annual ? ` (${usd(e.per_seat_price_annual)} billed annually)` : ""}; ${e.min_seats}–${e.max_seats} seats`;
    case "per_conversation":
      return `${usd(e.monthly_price)}/month for ${num(e.included_conversations)} conversations`;
    case "per_resolution":
      return `${usd(e.per_resolution_price)} per resolution + ${usd(e.per_seat_price)}/seat/month${e.per_seat_price_annual ? ` (${usd(e.per_seat_price_annual)} annual)` : ""}, min ${e.min_seats} seat`;
    case "per_task": {
      const t = e.task_tiers;
      return `${t.length} task tiers: ${usd(t[0].annual)}/month (annual) for ${num(t[0].tasks)} tasks up to ${usd(t.at(-1).annual)} for ${num(t.at(-1).tasks)}; monthly billing ${usd(t[0].monthly)}–${usd(t.at(-1).monthly)}`;
    }
  }
  if (e.category === "gpu_throughput") return `${num(e.value)} output tokens/s; prompt reading ${num(e.prefill_tokens_per_second)} tokens/s`;
  if (e.category === "social_api") return `${usd(e.post_price, 3)} per post, ${usd(e.owned_read_price, 3)} per owned read`;
  const unit = { usd_per_hour: "/hour", usd_per_month: "/month", usd_per_minute: "/minute", usd_per_1k_characters: " per 1,000 characters", usd_per_second: "/second", usd_per_image: "/image" }[e.unit] ?? ` (${e.unit})`;
  return `${usd(e.price)}${unit}${e.vram_gb ? `, ${e.vram_gb} GB VRAM` : ""}`;
}

const CATEGORY_LABELS = {
  gpu_rental: "GPU rental",
  gpu_throughput: "GPU speed (assumption)",
  managed_db: "Managed database",
  self_managed_db: "Self-managed database",
  vector_db: "Vector database",
  hosting: "App hosting",
  storage: "Storage",
  monitoring: "Monitoring",
  voice_stt: "Speech-to-text",
  voice_tts: "Text-to-speech",
  telephony: "Telephony",
  saas_chatbot: "SaaS plan",
  video_generation: "AI video",
  image_generation: "AI images",
  social_api: "Social API",
  market_data: "Market data",
};

function status(e) {
  if (e.category === "gpu_throughput" || !/^https:\/\//.test(e.source_url || "")) return confidence("estimate");
  return e.is_sample ? `${confidence("estimate")} sample` : confidence("verified");
}

function dataHtml(d) {
  const out = [];
  const h3 = (id, t) => out.push(`<h3 id="${id}">${t}</h3>`);
  const p = (t) => out.push(`<p>${t}</p>`);

  out.push('<h2 id="data">Reference data: every assumption and price</h2>');
  p(`These tables are built from the data files the advisor loads (<a href="${REPO}/tree/main/data" rel="noopener">data/</a>), so they show exactly the numbers it uses. <strong>verified</strong> means taken from an official vendor or government page; <strong>benchmark</strong> means an official statistic used as a proxy; <strong>estimate</strong> means a reasoned judgement or sample value that you should replace with your own figure. Every estimate can be changed in the advisor's form.`);

  // Assumption register
  h3("data-register", "Assumption register");
  p(d.assumptions.notes ? inline(String(d.assumptions.notes)) : "");
  out.push(
    table(
      ["Assumption", "Value", "Confidence", "Source", "Reviewed"],
      d.assumptions.entries.map((e) => [esc(e.label), esc(e.value), confidence(e.confidence), esc(e.source) + (e.source_url ? ` (${sourceLink(e.source_url, "link")})` : ""), shortDate(e.last_reviewed)]),
    ),
  );

  // AI model prices
  h3("data-llm-prices", "AI model prices (USD per million tokens)");
  const providers = Object.fromEntries(d.prices.llm_providers.map((x) => [x.id, x.label]));
  const llm = d.prices.entries.filter((e) => e.category === "llm_api");
  p(`The quality need picks the tier: basic → budget, good → mid, best available → premium. By default the cheapest provider for your request size is used (section 2). Batch prices apply to work that can wait; cached input applies to the share of each prompt that repeats, above the provider's minimum prompt size.`);
  out.push(
    table(
      ["Model", "Provider", "Tier", "Input", "Output", "Cached input", "Batch in / out", "Cache minimum", "Source", "Checked"],
      llm.map((e) => [
        esc(e.label) + (e.intro ? `<br><span class="muted">Introductory ${usd(e.intro.input_price)} / ${usd(e.intro.output_price)} until ${shortDate(e.intro.until)}; the later price is used</span>` : ""),
        esc(providers[e.provider] ?? e.provider),
        esc(e.tier),
        usd(e.input_price, 2),
        usd(e.output_price, 2),
        usd(e.cached_input_price, 3),
        e.batch_input_price != null ? `${usd(e.batch_input_price, 3)} / ${usd(e.batch_output_price, 2)}` : "—",
        e.cache_min_tokens ? `${num(e.cache_min_tokens)} tokens` : "none listed",
        sourceLink(e.source_url, "price page"),
        shortDate(e.last_verified),
      ]),
      { numCols: [3, 4, 5, 6] },
    ),
  );

  h3("data-open-prices", "Hosted open-model prices (option E, USD per million tokens)");
  out.push(
    table(
      ["Model", "Size class", "Input", "Output", "Source", "Checked"],
      d.prices.entries.filter((e) => e.category === "llm_open_hosted").map((e) => [esc(e.label), esc(e.model_class), usd(e.input_price, 2), usd(e.output_price, 2), sourceLink(e.source_url, "price page"), shortDate(e.last_verified)]),
      { numCols: [2, 3] },
    ),
  );

  // Self-hosting chain
  h3("data-selfhost", "Self-hosting: model sizes and GPU memory");
  p(esc(d.selfhost.notes));
  const q2m = Object.entries(d.selfhost.quality_to_model);
  out.push(
    table(
      ["Quality need", "Model class", "Parameters", "VRAM needed", "Weights", "KV cache per token", "Why"],
      q2m.map(([q, cls]) => {
        const m = d.selfhost.model_classes[cls];
        return [esc(q.replace(/_/g, " ")), esc(m.label), `${m.params_billion}B`, `${m.vram_gb_needed} GB`, `${m.weights_gb} GB`, `${m.kv_mb_per_token * 1024} KB`, esc(`${m.why}. ${m.kv_why}`)];
      }),
    ),
  );
  p(`Other self-hosting assumptions: ${Math.round(d.selfhost.usable_vram_share * 100)}% of VRAM is usable; one answer streams at about ${d.selfhost.stream_tokens_per_sec} tokens/second while batched; GPU counts carry ${Math.round((d.selfhost.headroom - 1) * 100)}% headroom; real-time voice adds ${Math.round((d.selfhost.realtime_voice_overhead - 1) * 100)}% overhead. ${esc(d.selfhost.open_model_note ?? "")}`);

  // Other prices
  h3("data-other-prices", "GPU, infrastructure, voice, SaaS and media prices");
  const other = d.prices.entries.filter((e) => !["llm_api", "llm_open_hosted"].includes(e.category));
  out.push(
    table(
      ["Item", "Type", "Price (USD, excl. tax)", "Status", "Source", "Checked"],
      other.map((e) => [esc(e.label), esc(CATEGORY_LABELS[e.category] ?? e.category), esc(priceText(e)), status(e), sourceLink(e.source_url, "price page"), shortDate(e.last_verified)]),
    ),
  );
  p("Notes recorded with each price (what is included, what was assumed):");
  out.push(`<ul class="price-notes">\n${d.prices.entries.filter((e) => e.notes).map((e) => `<li><strong>${esc(e.label)}</strong>: ${esc(e.notes)}</li>`).join("\n")}\n</ul>`);

  // Labour
  h3("data-labour", "Labour costs by country");
  p(`Staff cost is the hourly cost of the person doing the work today, fully loaded with employer on-costs; engineer cost is used for build and maintenance hours. ${esc(d.labour.notes ?? "")}`);
  out.push(
    table(
      ["Country", "Staff cost / hour", "Statistic", "Period", "On-costs", "Engineer / hour (USD)", "Hours per FTE / month"],
      d.regions.regions.map((r) => {
        const l = d.labour.regions[r.code];
        const staff = l ? `${num(l.staff_loaded_local)} ${esc(l.staff.currency)} (${usd(l.staff_loaded_usd)})` : usd(r.staff_hourly_usd);
        return [
          esc(r.name),
          staff,
          l ? `${esc(l.staff.statistic)}${l.staff.source_url ? ` (${sourceLink(l.staff.source_url)})` : ""} ${confidence(l.staff.confidence)}` : `${confidence("estimate")} sample value`,
          esc(l?.staff.period ?? "—"),
          l ? `× ${l.multiplier.value} ${esc(l.multiplier.basis)} ${confidence(l.multiplier.confidence)}` : "—",
          `${usd(r.engineer_hourly_usd)} ${confidence(l?.engineer ? l.engineer.confidence : "estimate")}`,
          num(r.fte_hours_per_month),
        ];
      }),
    ),
  );

  // Use cases
  h3("data-usecases", "Default volumes and token counts by use case");
  p(esc(d.usecases.notes));
  const uc = Object.values(d.usecases.usecases);
  out.push(
    table(
      ["Use case", "Input tokens", "Output tokens", "Cached share", "Retrieval (RAG)", "Other defaults"],
      uc.filter((u) => u.kind !== "agent").map((u) => {
        const extra = [];
        if (u.users_per_day) extra.push(`${u.users_per_day} users/day × ${u.requests_per_user} requests`);
        if (u.minutes_saved_per_request) extra.push(`${u.minutes_saved_per_request} minutes saved per request`);
        if (u.voice_minutes_per_conversation) extra.push(`${u.voice_minutes_per_conversation} minutes per call, ${u.tts_chars_per_minute} spoken characters/minute`);
        if (u.docs_per_month) extra.push(`${num(u.docs_per_month)} documents/month × ${u.pages_per_doc} pages × ${u.tokens_per_page} tokens/page, ${u.doc_out_tokens} output tokens per document`);
        return [esc(u.label), num(u.in_tokens), num(u.out_tokens), pct(u.cached_share_pct), u.rag ? "yes" : "no", esc(extra.join("; ") || "—")];
      }),
      { numCols: [1, 2, 3] },
    ),
  );
  p("Workflow agents (priced per task; section 10b):");
  out.push(
    table(
      ["Agent", "Tasks / month", "Steps", "Input / step", "Context growth / step", "Output / step", "Batch", "Minutes per task today", "Completion", "Review", "Errors × cost"],
      uc.filter((u) => u.kind === "agent").map((u) => [
        esc(u.label),
        num(u.tasks_per_month),
        u.steps_per_task,
        num(u.in_tokens_per_step),
        num(u.context_growth_per_step),
        num(u.out_tokens_per_step),
        u.batch ? "yes" : "no",
        u.human_minutes_per_task,
        pct(u.success_pct),
        `${pct(u.review_pct)} × ${u.review_minutes} min`,
        `${pct(u.error_pct)} × ${usd(u.cost_per_error_usd)}`,
      ]),
      { numCols: [1, 2, 3, 4, 5, 7] },
    ),
  );

  // Presets
  h3("data-presets", "Industry presets");
  p(esc(d.presets.notes));
  out.push(
    table(
      ["Industry", "Use case", "Users / day", "Ticket size", "Margin", "Conversion", "Purchases / year", "Human cost / conversation", "Reaching a person", "AI handles", "Tax reclaimable"],
      Object.values(d.presets.presets).map((x) => [
        esc(x.label),
        esc(d.usecases.usecases[x.use_case]?.label ?? x.use_case),
        num(x.users_per_day),
        usd(x.ticket_usd),
        pct(x.margin_pct),
        pct(x.conversion_pct),
        x.purchase_type === "repeat" ? x.purchases_per_year : "one-time",
        usd(x.human_cost_per_conv_usd),
        pct(x.human_share_pct),
        pct(x.deflection_pct),
        x.tax_reclaimable ? "yes" : "no",
      ]),
      { numCols: [2, 3, 4, 5, 7, 8, 9] },
    ),
  );

  // Taxes
  h3("data-tax", "Tax rates by country and region");
  const taxRows = [];
  for (const r of d.regions.regions) {
    for (const v of d.taxes.regions[r.code]?.variants || []) {
      for (const c of v.components) {
        taxRows.push([
          esc(r.name),
          esc(v.label),
          esc(c.name),
          c.rate_pct == null ? "you enter" : `${c.rate_pct}%`,
          c.recoverable ? "yes" : "no",
          `${c.is_sample ? `${confidence("estimate")} sample` : confidence("verified")}${c.notes ? ` ${esc(c.notes)}` : ""}`,
          sourceLink(c.source_url, "tax authority"),
        ]);
      }
    }
  }
  out.push(table(["Country", "Variant", "Tax", "Rate", "Reclaimable", "Status and notes", "Source"], taxRows, { numCols: [3] }));

  // FX
  h3("data-fx", "Exchange rates");
  p(`${esc(d.fx.notes)} Rates as of ${longDate(d.fx.as_of)}, from the ${sourceLink(d.fx.source_url, d.fx.source)}.`);
  out.push(table(["Currency", "Units per 1 USD"], Object.entries(d.fx.rates).map(([c, r]) => [c, r.toLocaleString("en-US", { maximumFractionDigits: 4 })]), { numCols: [1] }));

  return out.join("\n");
}

// ---------- Page assembly ----------

/** Latest review date across the data, used as the page's "last updated" date. */
export function lastUpdated(d) {
  const dates = [];
  const walk = (x, k) => {
    if (x && typeof x === "object") for (const [kk, v] of Object.entries(x)) walk(v, kk);
    else if (/^(last_verified|last_reviewed|as_of|date)$/.test(k || "") && /^\d{4}-\d{2}-\d{2}$/.test(x)) dates.push(x);
  };
  walk(d);
  return dates.sort().at(-1);
}

export function loadData() {
  return {
    assumptions: json("data/assumptions.json"),
    prices: json("data/prices.json"),
    selfhost: json("data/selfhost.json"),
    labour: json("data/labour.json"),
    regions: json("data/regions.json"),
    usecases: json("data/usecases.json"),
    presets: json("data/presets.json"),
    taxes: json("data/taxes.json"),
    fx: json("data/fx.json"),
    tokens: json("data/token-measurements.json"),
  };
}

const PUBLISHED = "2026-10-21";
const TITLE = "How AI Stack Advisor calculates AI cost, TCO and ROI";
export const DESCRIPTION =
  "Every formula, assumption and price behind AI Stack Advisor: LLM API token costs, self-hosted GPU sizing, SaaS plans, 36-month TCO, API vs self-hosting break-even, ROI, scoring and Monte Carlo simulation.";

function jsonLd(updated) {
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        "@id": `${PAGE_URL}#article`,
        headline: TITLE,
        description: DESCRIPTION,
        url: PAGE_URL,
        mainEntityOfPage: PAGE_URL,
        inLanguage: "en",
        datePublished: PUBLISHED,
        dateModified: updated,
        author: { "@type": "Person", "@id": "https://kaunteyacharya.com/#person", name: "Kauntey Acharya", url: "https://kaunteyacharya.com/" },
        about: { "@id": "https://kaunteyacharya.com/ai-stack-advisor/#app" },
        isPartOf: { "@id": "https://kaunteyacharya.com/#website" },
        keywords: "AI build vs buy, LLM API cost, self-hosted LLM cost, GPU sizing, total cost of ownership, TCO, break-even, ROI, AI cost calculator",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Kauntey Acharya", item: "https://kaunteyacharya.com/" },
          { "@type": "ListItem", position: 2, name: "AI Stack Advisor", item: "https://kaunteyacharya.com/ai-stack-advisor/" },
          { "@type": "ListItem", position: 3, name: "How it works", item: PAGE_URL },
        ],
      },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

/** Fixed sections written by hand in about.html, listed in the contents. */
const HAND_SECTIONS = [
  { id: "overview", title: "What it does" },
  { id: "summary", title: "The method in brief" },
];
const END_SECTIONS = [
  { id: "data-currency", title: "Keeping prices current" },
  { id: "limits", title: "Limitations" },
  { id: "privacy", title: "Privacy" },
  { id: "creator", title: "Creator" },
  { id: "contribute", title: "Contribute" },
];

export function generated(md = read("docs/METHODOLOGY.md"), d = loadData()) {
  const { html, toc } = methodHtml(md);
  const updated = lastUpdated(d);
  const li = (s) => `<li><a href="#${s.id}">${inline(s.title)}</a></li>`;
  return {
    ld: jsonLd(updated),
    updated: `<p class="muted page-date">Method and data last updated <time datetime="${updated}">${longDate(updated)}</time>.</p>`,
    toc: [
      '<nav class="toc" aria-labelledby="toc-title">',
      '<h2 id="toc-title">Contents</h2>',
      "<ol>",
      ...HAND_SECTIONS.map(li),
      `<li><a href="#method">Full method</a><ol>`,
      ...toc.map(li),
      "</ol></li>",
      `<li><a href="#data">Reference data</a><ol>`,
      li({ id: "data-register", title: "Assumption register" }),
      li({ id: "data-llm-prices", title: "AI model prices" }),
      li({ id: "data-open-prices", title: "Hosted open-model prices" }),
      li({ id: "data-selfhost", title: "Self-hosting model sizes" }),
      li({ id: "data-other-prices", title: "GPU, infrastructure, voice, SaaS and media prices" }),
      li({ id: "data-labour", title: "Labour costs by country" }),
      li({ id: "data-usecases", title: "Use-case defaults" }),
      li({ id: "data-presets", title: "Industry presets" }),
      li({ id: "data-tax", title: "Tax rates" }),
      li({ id: "data-fx", title: "Exchange rates" }),
      "</ol></li>",
      ...END_SECTIONS.map(li),
      "</ol>",
      "</nav>",
    ].join("\n"),
    method: `<section class="method" aria-labelledby="method">\n<h2 id="method">Full method: every formula</h2>\n${html}\n</section>`,
    data: `<section class="method" aria-labelledby="data">\n${dataHtml(d)}\n</section>`,
  };
}

const marker = (name) => [`<!-- GEN:${name} (scripts/build-about.mjs) -->`, `<!-- /GEN:${name} -->`];

export function fill(page, parts) {
  let out = page;
  for (const [name, content] of Object.entries(parts)) {
    const [a, b] = marker(name);
    const i = out.indexOf(a);
    const j = out.indexOf(b);
    if (i < 0 || j < i) throw new Error(`Markers for "${name}" not found in about.html`);
    out = out.slice(0, i + a.length) + "\n" + content + "\n" + out.slice(j);
  }
  return out;
}

if (process.argv[1]?.endsWith("build-about.mjs")) {
  const path = new URL("about.html", ROOT);
  const page = readFileSync(path, "utf8");
  const next = fill(page, generated());
  if (process.argv.includes("--write")) {
    writeFileSync(path, next);
    console.log("about.html updated from docs/METHODOLOGY.md and data/");
  } else if (next !== page) {
    console.error("about.html is out of date: run npm run docs:about");
    process.exit(1);
  } else console.log("about.html is up to date");
}
