// Renders the analysis into the results panel: tables, charts, report text.
// All user-provided text goes through textContent (never innerHTML).

import { explain } from "../engine/recommend.js";
import { CRITERIA, BASE_SCORES } from "../engine/scoring.js";
import { formatPp } from "../engine/value.js";
import { OPTION_IDS, OPTION_LABELS } from "../engine/inputs.js";
import { HOURS_PER_MONTH, DAYS_PER_MONTH } from "../engine/costs.js";
import { fromUsd, formatMoney, formatCompact } from "./format.js";
import { explainPortfolio, SHORT_LABELS } from "../engine/portfolio.js";
import { RANGE_SPECS } from "../engine/ranges.js";
import { relevantEntries, confidenceCounts, sortForReview, factorConfidence } from "../engine/register.js";

const $ = (id) => document.getElementById(id);

/** Small DOM helper: el("td", { class: "num" }, "text", childNode) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setTable(table, headers, rows, { numericFrom = 1 } = {}) {
  table.replaceChildren();
  const thead = el("thead", {}, el("tr", {}, headers.map((h, i) => el("th", { scope: "col", class: i >= numericFrom ? "num" : null }, h))));
  const tbody = el("tbody");
  for (const r of rows) {
    const cells = r.cells || r;
    tbody.append(
      el("tr", { class: r.class || null }, cells.map((c, i) => (i === 0 ? el("th", { scope: "row" }, c) : el("td", { class: i >= numericFrom ? "num" : null }, c)))),
    );
  }
  table.append(thead, tbody);
}

const SHORT = { A: "A. SaaS", B: "B. API", C: "C. Self-hosted", D: "D. Hybrid" };

const pctText = (x, d = 1) => (Number.isFinite(x) ? `${x.toFixed(d)}%` : "—");
const swatch = (id) => el("span", { class: `swatch swatch-${id}`, "aria-hidden": "true" });

function kpiWithTitle(node, title) {
  node.title = title;
  return node;
}

function kpi(label, value, sub) {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value, sub ? el("span", { class: "sub" }, sub) : null));
}

/** Headline money: primary currency, plus comparison currency underneath if chosen. */
function money2(ctx, usd) {
  const main = ctx.fmt.money(usd);
  const sub = ctx.cmpFmt ? `≈ ${ctx.cmpFmt.money(usd)}` : ctx.fmt.currency === "INR" ? ctx.fmt.compact(usd) : null;
  return { main, sub: sub && sub !== main ? sub : null };
}

/* ---------- main entry ---------- */

export function renderAll(result, ctx) {
  const { inputs, fmt, data } = ctx;
  const by = Object.fromEntries(result.options.map((o) => [o.id, o]));
  const best = by[result.recommended];

  $("report-title").textContent = inputs.company ? `AI stack recommendation for ${inputs.company}` : "AI stack recommendation";
  $("report-date").textContent = `Prepared ${new Date().toLocaleDateString(fmt.locale, { year: "numeric", month: "long", day: "numeric" })} · Figures in ${fmt.currency}`;
  $("fx-note").textContent =
    fmt.currency === "USD" && !ctx.cmpFmt
      ? `Calculated in USD. Exchange rates: ${data.fx.source}, ${data.fx.as_of} (reference rates).`
      : `Converted from USD at ECB reference rates of ${data.fx.as_of}${fmt.currency === "AED" || ctx.cmpFmt?.currency === "AED" ? " (AED from its 3.6725 USD peg)" : ""}.`;
  $("sample-banner").hidden = !result.hasSamplePrices;

  renderSummary(result, ctx, best);
  renderComparison(result, ctx);
  renderCharts(result, ctx);
  renderValue(result, ctx, best);
  renderMatrix(result, ctx);
  renderWarnings(result, ctx);
  renderAssumptions(result, ctx, best);
}

/* ---------- several workloads: one stack or a mix ---------- */

/** Renders the portfolio card (hidden for a single workload) and the "details for workload N" note. */
export function renderPortfolio(p, ctx) {
  const card = $("portfolio-card");
  const note = $("detail-note");
  card.hidden = !p;
  note.hidden = !p;
  if (!p) return;
  const { fmt } = ctx;
  note.textContent = `Details below are for workload ${ctx.activeW + 1}: ${ctx.workloadName}. Switch workloads with the tabs above the form.`;

  $("portfolio-text").replaceChildren(...explainPortfolio(p, (usd) => fmt.money(usd)).map((t) => el("p", {}, t)));
  const kpis = $("portfolio-kpis");
  kpis.replaceChildren();
  const r = p.recommended;
  if (!r) {
    for (const id of ["portfolio-table", "portfolio-workloads"]) $(id).replaceChildren();
    $("portfolio-stacks").replaceChildren();
    return;
  }
  kpis.append(
    kpi("Monthly cost, all workloads (month 1)", fmt.money(r.monthly1)),
    kpi("36-month total cost of ownership", fmt.money(r.tco36)),
    kpi("One-time build", fmt.money(r.oneTime)),
    kpi("Stacks to run", String(r.stacks.length), r.stacks.map((o) => SHORT_LABELS[o]).join(" + ")),
  );

  // Best combinations: the recommendation, best single stack, best mix, cheapest, then the next best by score.
  const tags = new Map();
  const tag = (c, t) => c && tags.set(c, [...(tags.get(c) || []), t]);
  tag(r, "Recommended");
  tag(p.bestSingle, "Best single stack");
  tag(p.bestMix, "Best mix");
  tag(p.cheapest, "Cheapest");
  const shown = [...new Set([...tags.keys(), ...p.combos.slice(0, 6)])].slice(0, 8).sort((a, b) => b.finalScore - a.finalScore);
  setTable(
    $("portfolio-table"),
    [...p.names, "Monthly (month 1)", "TCO 36 months", "Score /100", ""],
    shown.map((c) => ({
      class: c === r ? "is-recommended" : null,
      cells: [
        ...c.combo.map((o) => el("span", {}, swatch(o), SHORT_LABELS[o])),
        fmt.money(c.monthly1),
        fmt.money(c.tco36),
        (c.finalScore * 100).toFixed(0),
        (tags.get(c) || []).join(", "),
      ],
    })),
    { numericFrom: p.names.length },
  );
  // first column cells are rendered as row headers by setTable; keep option names left-aligned
  for (const td of $("portfolio-table").querySelectorAll("tbody td:last-child, thead th:last-child")) td.classList.remove("num");

  setTable(
    $("portfolio-workloads"),
    ["Workload", "Runs on", "Share of monthly cost", "Value"],
    p.detail.perWorkload.map((w) => [w.name, `${SHORT_LABELS[w.option]}${p.recommended.groups[w.option].length > 1 ? " (shared)" : ""}`, fmt.money(w.monthly), valueSummary(w, ctx)]),
    { numericFrom: 2 },
  );
  for (const td of $("portfolio-workloads").querySelectorAll("tbody td:last-child, thead th:last-child")) td.classList.remove("num");

  const stacks = $("portfolio-stacks");
  stacks.replaceChildren(
    ...p.detail.stacks.map((st) =>
      el(
        "div",
        { class: "portfolio-stack" },
        el("h4", {}, `${st.label}: ${st.workloads.map((i) => p.names[i]).join(" + ")}${st.gpus ? ` (${st.gpus} shared GPU${st.gpus > 1 ? "s" : ""})` : ""}`),
        el(
          "ul",
          { class: "workings-list" },
          st.lines.map((l) => el("li", {}, el("span", {}, l.label), el("span", { class: "formula" }, formulaText(l, fmt)), el("span", { class: "amt" }, fmt.money(l.usd)))),
          el("li", {}, el("span", {}, "Stack total per month"), el("span", { class: "formula" }, ""), el("span", { class: "amt" }, fmt.money(st.monthly))),
        ),
      ),
    ),
    el("p", { class: "muted" }, `Shared infrastructure is counted once per stack; GPUs are sized for the pooled peak; each extra workload on a stack adds ${ctx.inputs.extraWorkloadEffortPct}% of the stack's base build and maintenance hours. Each workload's share is in proportion to its own usage costs.`),
  );
}

function valueSummary(w, ctx) {
  const { fmt, inputs } = ctx;
  const v = w.value;
  if (w.agent) {
    const saved = inputs.valueUnit === "fte" ? `${fmt.number(v.fte, 2)} FTE` : `${fmt.number(Math.round(v.netHours))} hours/month`;
    return `Saves ${saved}; net ${fmt.money(v.net)}/month`;
  }
  const sales = Number.isFinite(v.salesNeeded) ? (v.breakevenExtraSales >= 1 ? `${fmt.number(v.salesNeeded)} extra sales/month` : "under one extra sale a month") : "—";
  return `Pays for itself with ${sales}; support savings ${fmt.money(v.supportSavings)}/month`;
}

/* ---------- assumption register ---------- */

const confBadge = (c) => el("span", { class: `conf conf-${c}` }, c);

/** Register table: every assumption behind this result, estimates first. */
export function renderRegister(result, ctx) {
  const used = (result?.pricesUsed || []).map((p) => p.id);
  const entries = sortForReview(relevantEntries(ctx.register, used));
  const counts = confidenceCounts(entries);
  $("register-summary").textContent = `This result rests on ${entries.length} figures: ${counts.verified} verified, ${counts.benchmark} benchmarks from official statistics, and ${counts.estimate} estimates. Estimates are listed first; replace them with your own figures where you can.`;
  setTable(
    $("register-table"),
    ["Confidence", "Assumption", "Value", "Source", "Last reviewed"],
    entries.map((e) => [
      confBadge(e.confidence),
      e.label,
      e.value,
      e.source_url ? el("span", {}, e.source, " ", el("a", { href: e.source_url, rel: "noopener" }, "source")) : e.source,
      e.last_reviewed || "—",
    ]),
    { numericFrom: 99 },
  );
}

/* ---------- how sure is this? (simulation and tornado) ---------- */

/**
 * @param sim  summary of simulation runs (null while running)
 * @param tor  tornado rows (null while running)
 */
export function renderSimulation(sim, tor, ctx) {
  const { fmt, inputs } = ctx;
  const text = $("sim-text");
  if (!sim || !tor) {
    text.replaceChildren(el("p", { class: "sim-pending" }, `Running ${ctx.runs} simulations…`));
    for (const id of ["sim-wins", "sim-pct", "tornado-table"]) $(id).replaceChildren();
    charts.tornado?.destroy();
    delete charts.tornado;
    return;
  }
  const order = Object.entries(sim.winShare).sort((a, b) => b[1] - a[1]);
  const [topId, topShare] = order[0];
  const pctText0 = (x) => `${Math.round(x * 100)}%`;
  // Lower-case the first letter for a running sentence, but keep acronyms (LLM, GPU) intact.
  const varied = sim.factors.map((f) => (/^[A-Z]{2}/.test(f.label) ? f.label : f.label[0].toLowerCase() + f.label.slice(1)));
  const inputsVaried = sim.factors.filter((f) => f.kind === "input").length;
  const money = (x) => (x == null ? "—" : fmt.money(x));
  const lead =
    topShare >= 0.9
      ? `Robust: ${OPTION_LABELS[topId]} comes out on top in ${pctText0(topShare)} of ${sim.runs} simulations.`
      : `Close call: ${OPTION_LABELS[topId]} wins ${pctText0(topShare)} of ${sim.runs} simulations, ${order.slice(1).map(([id, s]) => `${OPTION_LABELS[id]} ${pctText0(s)}`).join(", ")}.`;
  // Assumptions that move the result most AND rest on estimates: the ones to check first.
  const checkFirst = ctx.register
    ? tor.rows.filter((r) => r.swing >= 0.5 && factorConfidence(r.id, ctx.register, ctx.usedPriceIds) === "estimate").slice(0, 3).map((r) => r.label.toLowerCase().replace(/\b(llm|gpu|ai|api)\b/g, (m) => m.toUpperCase()))
    : [];
  text.replaceChildren(
    el("p", {}, el("strong", {}, lead), ` Net benefit is ${money(sim.net.p10)} to ${money(sim.net.p90)} a month (10th–90th percentile)${sim.probNetPositive < 1 ? `, and positive in ${pctText0(sim.probNetPositive)} of runs` : ""}.`),
    checkFirst.length ? el("p", {}, el("strong", {}, "Check these first: "), `${checkFirst.join(", ")}. They move the result most and are still estimates.`) : null,
    el("p", { class: "muted" }, `Each run draws ${varied.length} quantities from realistic ranges: ${varied.join(", ")}. ${inputsVaried ? "" : "Mark inputs as “Not sure” to include them. "}${ctx.multi ? `Shown for workload: ${ctx.workloadName}. ` : ""}Net benefit counts time saved, or support savings with no sales uplift, minus AI cost.`),
  );

  setTable($("sim-wins"), ["Option", "Recommended in"], order.map(([id, s]) => ({ class: id === topId ? "is-recommended" : null, cells: [OPTION_LABELS[id], pctText0(s)] })));
  setTable(
    $("sim-pct"),
    ["Result (recommended option in each run)", "10th percentile", "Median", "90th percentile"],
    [
      ["Monthly AI cost", money(sim.monthly.p10), money(sim.monthly.p50), money(sim.monthly.p90)],
      ["Net benefit per month", money(sim.net.p10), money(sim.net.p50), money(sim.net.p90)],
      ["36-month cost, present value", money(sim.pv36.p10), money(sim.pv36.p50), money(sim.pv36.p90)],
    ],
  );

  const measured = tor.rows.filter((r) => r.lowNet != null && r.highNet != null);
  const rows = measured.filter((r) => r.swing >= 0.5 || r.flips).slice(0, 10);
  const noEffect = measured.filter((r) => r.swing < 0.5 && !r.flips).map((r) => r.label);
  const endText = (r, end) => {
    const v = end === "low" ? r.lowValue : r.highValue;
    if (r.kind === "input") return r.id.endsWith("Pct") ? `${fmt.number(v, 1)}%` : fmt.number(v, v < 10 ? 1 : 0);
    return r.absolute ? `${fmt.number(v, 0)} pts` : `×${fmt.number(v, 2)}`;
  };
  $("tornado-note").textContent = `Net benefit per month at the typical inputs: ${money(tor.base.net)}. Each bar moves one assumption alone to its low and high end. ⚑ = the recommendation changes.${noEffect.length ? ` No effect on this result: ${noEffect.join(", ")}.` : ""}`;
  setTable(
    $("tornado-table"),
    ["Assumption", "Low end", "Net benefit", "High end", "Net benefit", "Swing"],
    rows.map((r) => [`${r.label}${r.flips ? " ⚑" : ""}`, endText(r, "low"), money(r.lowNet), endText(r, "high"), money(r.highNet), money(r.swing)]),
  );

  const Chart = window.Chart;
  if (!Chart) return;
  drawChart("tornado", $("tornado-chart"), {
    type: "bar",
    data: {
      labels: rows.map((r) => `${r.label}${r.flips ? " ⚑" : ""}`),
      datasets: [
        {
          label: "Net benefit per month, low to high end",
          data: rows.map((r) => [Math.min(r.lowNet, r.highNet), Math.max(r.lowNet, r.highNet)].map(toLocal(fmt))),
          backgroundColor: rows.map((r) => (r.kind === "input" ? cssVar("--opt-b") : cssVar("--opt-a"))),
          borderWidth: 0,
          barPercentage: 0.7,
        },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { grid: { color: cssVar("--hair") }, ticks: { callback: (v) => formatCompact(v, fmt.currency, fmt.locale) }, title: { display: true, text: `Net benefit per month (${fmt.currency})` } },
        y: { grid: { display: false }, ticks: { autoSkip: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              const r = rows[c.dataIndex];
              return `${endText(r, "low")}: ${money(r.lowNet)} · ${endText(r, "high")}: ${money(r.highNet)}`;
            },
          },
        },
      },
    },
  });
}

/** Converts USD to the display currency for chart data (the formatter carries the rate). */
const toLocal = (fmt) => (usd) => (Number.isFinite(usd) ? usd * fmt.rateFromUsd : null);

/* ---------- "not sure?" ranges ---------- */

/** Range box in the summary: results with every uncertain input at its low and high end. */
export function renderRange(range, ctx) {
  const box = $("sum-range");
  box.hidden = !range;
  if (!range) return box.replaceChildren();
  const { fmt, inputs } = ctx;
  const span = (metric, f) => {
    const s = range.span(metric);
    if (!s) return null;
    const [a, b] = s.map(f);
    return a === b ? a : `${a} – ${b}`;
  };
  const rows = [];
  const add = (label, value) => value && rows.push(el("dt", {}, label), el("dd", {}, value));
  add("Monthly cost", span("monthly", (x) => fmt.money(x)));
  add("36-month total cost", span("tco36", (x) => fmt.money(x)));
  if (inputs.valueUnit === "fte") add("Time saved", span("fte", (x) => `${fmt.number(x, 2)} FTE`));
  else add("Time saved", span("netHours", (x) => `${fmt.number(Math.round(x))} h/month`));
  add("Net benefit", span("net", (x) => `${fmt.money(x)}/month`));
  add("Extra sales to break even", span("salesNeeded", (x) => `${fmt.number(x)}/month`));
  add("Support savings", span("supportSavings", (x) => `${fmt.money(x)}/month`));
  const paybacks = Object.values(range.cases).filter(Boolean).map((c) => c.paybackMonths);
  if (!range.portfolio && paybacks.length) {
    const nums = paybacks.filter((x) => x != null);
    const never = paybacks.some((x) => x == null);
    const text = !nums.length ? "never" : `${Math.min(...nums).toFixed(1)} – ${never ? "never" : `${Math.max(...nums).toFixed(1)} months`}`;
    add("Payback", nums.length && !never && Math.min(...nums) === Math.max(...nums) ? `${nums[0].toFixed(1)} months` : text);
  }
  add(
    "Recommendation",
    range.recommendationChanges
      ? `changes: ${range.cases.low?.recommendedLabel ?? "—"} at the low end, ${range.cases.high?.recommendedLabel ?? "—"} at the high end`
      : `${range.labels[0]} in every case`,
  );
  const names = range.keys.map((k) => RANGE_SPECS[k].label.toLowerCase()).join(", ");
  box.replaceChildren(
    el("h3", {}, "If your estimates are off"),
    el("p", {}, `You marked ${range.keys.length === 1 ? "one input" : `${range.keys.length} inputs`} as not sure (${names}). These ranges put all of them at the low end, then all at the high end.`),
    el("dl", {}, rows),
  );
}

/* ---------- 1. executive summary ---------- */

function renderSummary(result, ctx, best) {
  const { fmt } = ctx;
  const kpis = $("sum-kpis");
  kpis.replaceChildren();
  const text = $("sum-text");
  text.replaceChildren();
  if (!best) {
    $("sum-title").textContent = "No viable option";
    text.append(el("p", {}, "Every option is excluded by the current constraints. Relax the data or team requirements to see a recommendation."));
    return;
  }
  $("sum-title").textContent = `Recommended: ${best.label}`;
  const m = money2(ctx, best.monthly);
  const t = money2(ctx, best.tco36);
  kpis.append(
    kpiWithTitle(kpi("Expected monthly cost (month 1)", m.main, m.sub), workingsTitle(best, fmt).replace(" Click for the workings.", "")),
    kpi("Monthly range (½× to 2× volume)", `${fmt.compact(result.monthlyRange.low)} – ${fmt.compact(result.monthlyRange.high)}`),
    kpi("36-month total cost of ownership", t.main, [t.sub, ctx.inputs.growthPct > 0 ? `${fmt.money(best.tco36NoGrowth)} with no growth` : null].filter(Boolean).join(" · ") || null),
    kpi("One-time build cost", fmt.money(best.oneTime)),
  );
  const sentences = explain({
    inputs: ctx.inputs,
    best,
    options: result.options,
    breakeven: result.breakeven,
    profile: result.profile,
    vol: result.volume,
    money: (usd) => fmt.money(usd),
    number: (n) => fmt.number(n),
    robustness: result.robustness,
    hybrid: result.hybrid,
    tax: result.tax,
  });
  for (const s of sentences) text.append(el("p", {}, s));
}

/* ---------- 2. comparison table ---------- */

// Options whose workings are open; kept across re-renders so live updates don't collapse them.
const openWorkings = new Set();

/** "200,040 requests × ₹0.138" — the formula behind one cost line, in the display currency. */
export function formulaText(line, fmt) {
  if (line.basis?.length) {
    return line.basis
      .map((b) => `${fmt.number(b.qty, b.qty < 10 ? 2 : 0)} ${b.unit} × ${fmt.rate(b.rate)}`)
      .join(" + ");
  }
  if (line.tax) return `${+line.taxPct.toFixed(3)}% × ${fmt.money(line.taxBase)} vendor spend`;
  return "flat monthly price";
}

/** One-line summary for hover: "₹27,640 LLM API + ₹2,382 DB + …". */
function workingsTitle(o, fmt) {
  return `${fmt.money(o.monthly)} = ` + o.lines.map((l) => `${fmt.money(l.usd)} ${shortLabel(l.label)}`).join(" + ") + ". Click for the workings.";
}

const shortLabel = (label) => label.replace(/\s*\([^)]*\)/g, "").replace(/^SaaS: /, "");

function renderComparison(result, ctx) {
  const { fmt } = ctx;
  const table = $("cmp-table");
  const headers = ["Option", "Monthly (month 1)", "One-time", "TCO 36 months", "TCO 36, no growth", "Decision cost*", "Score /100", "Status"];
  setTable(table, headers, [], { numericFrom: 1 });
  table.querySelector("thead th:last-child").classList.remove("num");
  const tbody = table.tBodies[0];

  for (const o of result.options) {
    const cost = (x) => (o.excluded || !Number.isFinite(x) ? "—" : fmt.money(x));
    const status = el("span", { class: `status status-${o.status}` }, o.status);
    const open = openWorkings.has(o.id);
    const workingsId = `workings-${o.id}`;

    let monthlyCell = cost(o.monthly);
    if (!o.excluded && Number.isFinite(o.monthly)) {
      monthlyCell = el("button", { type: "button", class: "cost-btn", "aria-expanded": String(open), "aria-controls": workingsId, title: workingsTitle(o, fmt) }, fmt.money(o.monthly));
      monthlyCell.addEventListener("click", () => {
        const row = document.getElementById(workingsId);
        const nowOpen = row.hidden;
        row.hidden = !nowOpen;
        monthlyCell.setAttribute("aria-expanded", String(nowOpen));
        nowOpen ? openWorkings.add(o.id) : openWorkings.delete(o.id);
      });
    }

    const cells = [
      el("th", { scope: "row" }, el("span", { title: o.label }, swatch(o.id), SHORT[o.id])),
      el("td", { class: "num" }, monthlyCell),
      el("td", { class: "num" }, cost(o.oneTime)),
      el("td", { class: "num" }, cost(o.tco36)),
      el("td", { class: "num" }, cost(o.tco36NoGrowth)),
      el("td", { class: "num", title: o.valueLostPv > 1 ? `${fmt.money(o.pv36)} present value of cost + ${fmt.money(o.valueLostPv)} value lost through lower completion` : `${fmt.money(o.pv36)} present value of cost` }, cost(o.decisionCost)),
      el("td", { class: "num" }, o.excluded ? "—" : (o.finalScore * 100).toFixed(0)),
      el("td", {}, o.excluded ? el("span", {}, status, " ", o.excluded) : status),
    ];
    tbody.append(el("tr", { class: o.excluded ? "is-excluded" : o.status === "recommended" ? "is-recommended" : null }, cells));

    if (!o.excluded && o.lines.length) {
      const list = el(
        "ul",
        { class: "workings-list" },
        o.lines.map((l) => el("li", {}, el("span", {}, l.label), el("span", { class: "formula" }, formulaText(l, fmt)), el("span", { class: "amt" }, fmt.money(l.usd)))),
        el("li", {}, el("span", {}, `${SHORT[o.id]}: total per month`), el("span", { class: "formula" }, ""), el("span", { class: "amt" }, fmt.money(o.monthly))),
      );
      const row = el("tr", { class: "workings", id: workingsId }, el("td", { colspan: String(headers.length) }, list));
      row.hidden = !open;
      tbody.append(row);
    }
  }
  let note = $("cmp-note");
  if (!note) {
    note = el("p", { id: "cmp-note", class: "muted" });
    table.closest(".table-wrap").after(note);
  }
  note.textContent = `* Decision cost: the 36-month cost in present value (discounted at ${ctx.inputs.discountRatePct}% a year), plus the value an option gives up because open models complete fewer tasks (${ctx.inputs.openModelGapPct} points, your assumption). Options are ranked on this, together with the non-cost scores.`;
}

/* ---------- 3–4. charts ---------- */

const charts = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderCharts(result, ctx) {
  const { fmt } = ctx;
  const colors = { A: cssVar("--opt-a"), B: cssVar("--opt-b"), C: cssVar("--opt-c"), D: cssVar("--opt-d") };
  const ink = cssVar("--ink-soft");
  const grid = cssVar("--hair");
  const viable = result.options.filter((o) => !o.excluded).map((o) => o.id);
  const curve = result.curve;

  // Text alternatives (always rendered, so the data is accessible and printable)
  const step = Math.max(1, Math.floor(curve.volumes.length / 10));
  const curveRows = curve.volumes
    .map((v, i) => [fmt.number(Math.round(v)), ...viable.map((id) => (Number.isFinite(curve.series[id][i]) ? fmt.money(curve.series[id][i]) : "—"))])
    .filter((_, i) => i % step === 0 || i === curve.volumes.length - 1);
  setTable($("curve-table"), ["Requests / month", ...viable.map((id) => `${id}. ${OPTION_LABELS[id]}`)], curveRows);

  const tcoRows = [0, 5, 11, 17, 23, 29, 35].map((m) => [`Month ${m + 1}`, ...viable.map((id) => fmt.money(result.tco[id].cumulative[m]))]);
  setTable($("tco-table"), ["Month", ...viable.map((id) => `${id}. ${OPTION_LABELS[id]}`)], tcoRows);

  // Only crossovers that involve the recommended option, so the list stays readable
  const cross = curve.crossovers.filter((c) => c.between.every((id) => viable.includes(id)) && c.between.includes(result.recommended));
  const list = $("crossovers");
  list.replaceChildren(
    ...cross.map((c) =>
      el("li", {}, `${OPTION_LABELS[c.between[0]]} and ${OPTION_LABELS[c.between[1]]} cross at ~${fmt.number(Math.round(c.requestsPerMonth))} requests/month (${fmt.money(c.costUsd)}/month); ${OPTION_LABELS[c.cheaperAbove]} is cheaper above that.`),
    ),
  );
  if (!cross.length) list.append(el("li", {}, "No crossovers between viable options in this range."));

  const Chart = window.Chart;
  if (!Chart) return; // chart library not loaded yet; tables above still show the data

  Chart.defaults.color = ink;
  Chart.defaults.font.family = cssVar("--font") || "system-ui";
  // Charts plot amounts in the display currency, so log-axis ticks land on round local figures.
  const local = (usd) => (Number.isFinite(usd) ? fromUsd(usd, fmt.currency, ctx.data.fx) : null);
  const moneyTick = (v) => formatCompact(v, fmt.currency, fmt.locale);
  const tooltipMoney = (c) => `${c.dataset.label}: ${formatMoney(c.parsed.y, fmt.currency, fmt.locale)}`;
  // Tooltip rows in the same top-to-bottom order as the lines (highest cost first), with the cheapest named.
  const costTooltip = (title, cheapestLabel) => ({
    itemSort: (a, b) => b.parsed.y - a.parsed.y,
    filter: (item) => item.dataset.type !== "scatter",
    callbacks: {
      title,
      label: tooltipMoney,
      footer: (items) => {
        const rows = items.filter((i) => i.dataset.type !== "scatter" && Number.isFinite(i.parsed.y));
        if (rows.length < 2) return "";
        const low = rows.reduce((a, b) => (b.parsed.y < a.parsed.y ? b : a));
        return `${cheapestLabel}: ${low.dataset.label.replace(/^[A-D]\. /, "")}`;
      },
    },
  });

  const curveData = {
    datasets: [
      ...viable.map((id) => ({
        label: `${id}. ${OPTION_LABELS[id]}`,
        data: curve.volumes.map((v, i) => ({ x: v, y: local(curve.series[id][i]) })),
        borderColor: colors[id],
        backgroundColor: colors[id],
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      })),
      {
        type: "scatter",
        label: "Crossover",
        data: cross.map((c) => ({ x: c.requestsPerMonth, y: local(c.costUsd) })),
        backgroundColor: cssVar("--bg"),
        borderColor: cssVar("--ink"),
        pointRadius: 5,
        borderWidth: 2,
      },
    ],
  };
  drawChart("curve", $("curve-chart"), {
    type: "line",
    data: curveData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { type: "logarithmic", title: { display: true, text: "Requests per month (log scale)" }, grid: { color: grid }, ticks: { callback: (v) => (isPowerOf10(v) ? fmt.number(v) : "") } },
        y: { type: "logarithmic", title: { display: true, text: `Monthly cost (${fmt.currency})` }, grid: { color: grid }, ticks: { callback: (v) => (isPowerOf10(v) ? moneyTick(v) : "") } },
      },
      plugins: {
        tooltip: costTooltip((items) => `${fmt.number(Math.round(items[0].parsed.x))} requests/month`, "Cheapest at this volume"),
        legend: { labels: { boxWidth: 12 } },
      },
    },
  });

  drawChart("tco", $("tco-chart"), {
    type: "line",
    data: {
      labels: Array.from({ length: 36 }, (_, i) => i + 1),
      datasets: viable.map((id) => ({
        label: `${id}. ${OPTION_LABELS[id]}`,
        data: result.tco[id].cumulative.map(local),
        borderColor: colors[id],
        backgroundColor: colors[id],
        borderWidth: 2,
        pointRadius: 0,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { title: { display: true, text: "Month" }, grid: { color: grid } },
        y: { title: { display: true, text: `Cumulative cost (${fmt.currency})` }, grid: { color: grid }, ticks: { callback: moneyTick } },
      },
      plugins: { tooltip: costTooltip((items) => `Month ${items[0].label} · total so far, highest first`, "Cheapest so far"), legend: { labels: { boxWidth: 12 } } },
    },
  });
}

/** Log axes only label 1, 10, 100… so ticks stay readable in every currency. */
function isPowerOf10(v) {
  const lg = Math.log10(v);
  return Math.abs(lg - Math.round(lg)) < 1e-9;
}

function drawChart(key, canvas, config) {
  charts[key]?.destroy();
  charts[key] = new window.Chart(canvas, config);
}

/* ---------- 5. value & ROI ---------- */

function renderValue(result, ctx, best) {
  const { fmt, inputs } = ctx;
  const lead = $("value-lead");
  const kpis = $("value-kpis");
  kpis.replaceChildren();
  if (!best || !best.value) {
    lead.textContent = "";
    setTable($("roi-table"), ["Uplift"], []);
    setTable($("deflection-table"), ["Deflection"], []);
    return;
  }
  const v = best.value;
  const agent = v.kind === "agent";
  $("deflection-title").hidden = agent;
  $("deflection-table").closest(".table-wrap").hidden = agent;
  if (agent) return renderAgentValue(result, ctx, best, v);
  $("roi-title").textContent = "ROI by conversion uplift";
  const salesText =
    v.breakevenExtraSales >= 1
      ? `${fmt.number(v.salesNeeded)} extra sales per month`
      : `about one extra sale every ${fmt.number(Math.ceil(1 / v.breakevenExtraSales))} months`;
  lead.replaceChildren(
    el("strong", {}, `${best.label} pays for itself with ${salesText}`),
    ` (+${formatPp(v.breakevenConversionUpliftPp)} percentage points of conversion), counting only the gross profit on a first sale.`,
    v.hasLtvLine ? ` Counting repeat purchases: ~${fmt.number(v.ltvCustomersNeeded)} new customers/month, value realised over 12 months.` : "",
  );
  kpis.append(
    kpi("Value per conversation", fmt.money(v.valuePerConversation), `Acceptable AI cost at ${inputs.targetSharePct}%: ${fmt.money(v.acceptableAiCostPerConversation)}`),
    kpi("AI cost per conversation", fmt.money(v.aiCostPerConversation), v.aiCostPerConversation > v.acceptableAiCostPerConversation ? "Above your target share" : "Within your target share"),
    kpi("AI cost as % of ticket", pctText(v.aiCostPctOfTicket, 2), `${fmt.money(v.aiCostPerSale)} per sale`),
    kpi("Support savings / month", fmt.money(v.supportSavings), `${inputs.humanSharePct}% reach a person today; AI fully handles ${inputs.deflectionPct}% of those`),
    kpi("Payback (no uplift)", v.paybackAt(0) == null ? "Never" : `${v.paybackAt(0).toFixed(1)} months`, "From support savings alone"),
  );

  setTable(
    $("roi-table"),
    ["Conversion uplift", "Extra sales / month", "Monthly ROI", "Payback"],
    v.sensitivity.map((s) => [
      `+${s.upliftPp} pp`,
      fmt.number(result.volume.conversationsPerMonth * (s.upliftPp / 100), 1),
      pctText(s.roi * 100, 0),
      s.paybackMonths == null ? "Never" : `${s.paybackMonths.toFixed(1)} months`,
    ]),
  );

  setTable(
    $("deflection-table"),
    ["Deflection rate", "Support savings / month", `${best.id}. monthly cost`, "ROI with no uplift", "SaaS monthly cost"],
    result.deflectionSensitivity.map((d) => ({
      class: d.deflectionPct === inputs.deflectionPct ? "is-recommended" : null,
      cells: [`${d.deflectionPct}%`, fmt.money(d.supportSavings), fmt.money(d.recommendedMonthly), pctText(d.roiAtZeroUplift * 100, 0), d.saasMonthly == null ? "—" : fmt.money(d.saasMonthly)],
    })),
  );
}

/** Time saved, in the unit the user chose. */
export function timeSaved(v, inputs, fmt) {
  const hours = `${fmt.number(Math.round(v.netHours))} hours/month`;
  const fte = `${fmt.number(v.fte, 2)} FTE`;
  return inputs.valueUnit === "fte" ? { main: fte, sub: hours } : { main: hours, sub: fte };
}

function renderAgentValue(result, ctx, best, v) {
  const { fmt, inputs } = ctx;
  const unit = ctx.data.usecases.usecases[inputs.useCase]?.task_unit || "tasks";
  const t = timeSaved(v, inputs, fmt);
  const lead = $("value-lead");
  if (v.internal) return renderInternalValue(result, ctx, best, v, t);
  lead.replaceChildren(
    el("strong", {}, `With the recommended setup (${best.label}), the agent saves ${t.main}`),
    ` (${t.sub}) of manual work after review time, worth ${fmt.money(v.benefit)} a month net of errors, against ${fmt.money(best.monthly)} of AI cost. `,
    v.net > 0
      ? `It pays for itself if the agent completes at least ${Math.min(100, Math.ceil(v.breakevenSuccessPct))}% of ${unit} on its own.`
      : v.breakevenSuccessPct <= 100
        ? `It does not pay for itself yet: it needs to complete at least ${Math.ceil(v.breakevenSuccessPct)}% of ${unit} on its own.`
        : "Even at 100% completion it would not cover its cost at this volume.",
  );
  $("value-kpis").append(
    kpi("Time saved (after review)", t.main, t.sub),
    kpi("Value of time saved", fmt.money(v.netHours * inputs.staffHourlyUsd), `${fmt.money(inputs.staffHourlyUsd)}/hour`),
    kpi("Error cost / month", fmt.money(v.errorCost), `${inputs.errorPct}% of ${unit} × ${fmt.money(inputs.costPerErrorUsd)}`),
    kpi(`AI cost per ${unit.replace(/s$/, "")}`, fmt.money(v.aiCostPerTask), `Value per ${unit.replace(/s$/, "")}: ${fmt.money(v.valuePerTask)}`),
    kpi("Net benefit / month", fmt.money(v.net), v.net > 0 ? `ROI ${pctText(v.roi * 100, 0)}` : "Negative at these assumptions"),
    kpi("Payback of build cost", v.paybackMonths == null ? "Never" : `${v.paybackMonths.toFixed(1)} months`),
  );
  $("roi-title").textContent = "Sensitivity to completion rate";
  setTable(
    $("roi-table"),
    ["Completed without a person", inputs.valueUnit === "fte" ? "FTE saved" : "Hours saved / month", "Net benefit / month", "Monthly ROI", "Payback"],
    v.sensitivity.map((s) => [
      `${s.successPct}%`,
      inputs.valueUnit === "fte" ? fmt.number(s.fte, 2) : fmt.number(Math.round(s.netHours)),
      fmt.money(s.net),
      pctText(s.roi * 100, 0),
      s.paybackMonths == null ? "Never" : `${s.paybackMonths.toFixed(1)} months`,
    ]),
  );
}


function renderInternalValue(result, ctx, best, v, t) {
  const { fmt, inputs } = ctx;
  $("value-lead").replaceChildren(
    el("strong", {}, `With the recommended setup (${best.label}), the tool saves ${t.main}`),
    ` (${t.sub}) of staff time at ${inputs.minutesSavedPerRequest} minutes per request, worth ${fmt.money(v.benefit)} a month against ${fmt.money(best.monthly)} of AI cost. `,
    `It pays for itself if each request saves at least ${v.breakevenMinutesPerRequest < 1 ? "a few seconds" : `${Math.ceil(v.breakevenMinutesPerRequest * 10) / 10} minutes`}.`,
  );
  $("value-kpis").append(
    kpi("Staff time saved", t.main, t.sub),
    kpi("Value of time saved", fmt.money(v.benefit), `${fmt.money(inputs.staffHourlyUsd)}/hour`),
    kpi("AI cost per request", fmt.rate(v.aiCostPerTask)),
    kpi("Net benefit / month", fmt.money(v.net), v.net > 0 ? `ROI ${pctText(v.roi * 100, 0)}` : "Negative at these assumptions"),
    kpi("Payback of build cost", v.paybackMonths == null ? "Never" : `${v.paybackMonths.toFixed(1)} months`),
  );
  $("roi-title").textContent = "Sensitivity to minutes saved";
  setTable(
    $("roi-table"),
    ["Minutes saved per request", inputs.valueUnit === "fte" ? "FTE saved" : "Hours saved / month", "Net benefit / month", "Monthly ROI", "Payback"],
    v.sensitivity.map((s) => ({
      class: s.minutes === inputs.minutesSavedPerRequest ? "is-recommended" : null,
      cells: [
        fmt.number(s.minutes, 1),
        inputs.valueUnit === "fte" ? fmt.number(s.fte, 2) : fmt.number(Math.round(s.netHours)),
        fmt.money(s.net),
        pctText(s.roi * 100, 0),
        s.paybackMonths == null ? "Never" : `${s.paybackMonths.toFixed(1)} months`,
      ],
    })),
  );
}

/* ---------- 6. decision matrix ---------- */

function renderMatrix(result, ctx) {
  const { inputs } = ctx;
  const s = result.scoring.scores;
  const by = Object.fromEntries(result.options.map((o) => [o.id, o]));
  const rows = CRITERIA.map((c) => [c.label, `${inputs.weights[c.id] ?? 0}`, ...OPTION_IDS.map((id) => (by[id].excluded ? "—" : String(s[c.id][id])))]);
  rows.push({ class: "is-recommended", cells: ["Non-cost score /100", "", ...OPTION_IDS.map((id) => (by[id].excluded ? "—" : (by[id].nonCostScore * 100).toFixed(0)))] });
  rows.push(["Cost score /100 (lower 36-month TCO = higher)", "", ...OPTION_IDS.map((id) => (by[id].excluded ? "—" : (by[id].costScore * 100).toFixed(0)))]);
  rows.push({
    class: "is-recommended",
    cells: [`Final score /100 (cost weight ${(result.costWeight * 100).toFixed(0)}%)`, "", ...OPTION_IDS.map((id) => (by[id].excluded ? "excluded" : (by[id].finalScore * 100).toFixed(0)))],
  });
  setTable($("matrix-table"), ["Criterion", "Weight", ...OPTION_IDS.map((id) => SHORT[id])], rows);

  // Score reasons as tooltips (title) on cells, for people who want the "why"
  const body = $("matrix-table").tBodies[0];
  CRITERIA.forEach((c, r) => {
    OPTION_IDS.forEach((id, k) => {
      const cell = body.rows[r].cells[k + 2];
      if (cell) cell.title = BASE_SCORES[c.id][id][1];
    });
  });

  const rob = $("robustness");
  const r = result.robustness;
  rob.className = `robustness ${r.robust ? "is-robust" : "is-close"}`;
  if (!result.recommended) rob.textContent = "";
  else if (r.robust) rob.textContent = "Robust: the recommendation holds when any single weight moves ±10 points.";
  else {
    const f = r.flips[0];
    rob.textContent = `Close call, decided by ${f.label.toLowerCase()}: moving it ${f.direction} 10 points makes ${OPTION_LABELS[f.winner] ?? f.winner} the top option.`;
  }
}

/* ---------- 7. warnings ---------- */

function renderWarnings(result, ctx) {
  const list = $("warnings");
  list.replaceChildren();
  const add = (level, text) => list.append(el("li", {}, el("span", { class: `lvl lvl-${level}` }, level), text));
  if (result.hasSamplePrices) add("warning", "Some prices are sample values, not verified quotes.");
  for (const w of ctx.validation.warnings) add(w.level, w.message);
  for (const w of result.warnings) add("risk", w.message);
  for (const o of result.options) for (const n of o.notes) add("info", `${o.label}: ${n}`);
  if (result.options.find((o) => o.id === "A")?.pricingType) add("info", "SaaS prices are list prices; volume customers usually negotiate.");
  for (const n of ctx.data.usecases.usecases[ctx.inputs.useCase]?.notes || []) add("warning", n);
  for (const n of result.tax.notes) add("info", `${result.tax.name}: ${n}`);
  for (const c of result.tax.components) if (c.isSample) add("warning", `Tax rate ${c.name} is a sample value; verify it with the tax authority.`);
  if (!list.children.length) add("info", "No warnings for these inputs.");

  const law = $("law-note");
  law.replaceChildren(el("strong", {}, "Relevant regulation to review with a legal advisor: "), ctx.lawNote || "—", el("span", { class: "muted" }, " This is not legal advice."));
}

/* ---------- 8. assumptions & prices ---------- */

function renderAssumptions(result, ctx, best) {
  const { inputs, fmt, data } = ctx;
  const sh = data.selfhost;
  const modelClass = sh.quality_to_model[inputs.quality];
  const model = sh.model_classes[modelClass];
  const c = result.options.find((o) => o.id === "C");
  const sampleTag = (yes) => (yes ? " (sample, verify)" : "");
  const region = data.regions.regions.find((r) => r.code === inputs.region);
  const rows = [
    ["Month length", `${DAYS_PER_MONTH} days, ${HOURS_PER_MONTH} hours`],
    ...(result.valueKind === "agent"
      ? [
          ["Tasks in month 1", `${fmt.number(Math.round(result.volume.tasks))} ${data.usecases.usecases[inputs.useCase].task_unit}`],
          ["LLM calls in month 1", `${fmt.number(Math.round(result.volume.requestsPerMonth))} (${inputs.stepsPerTask} steps per task${inputs.useCase === "content_engine" ? ", plus replies" : ""})`],
          ["Context growth", `${fmt.number(inputs.contextGrowthPerStep)} tokens added per step; each step re-reads what came before`],
          ["API pricing", inputs.useBatch ? "Batch prices (asynchronous, where the provider lists them)" : "Standard prices"],
          ["Workflow-tool steps per task", `${inputs.saasStepsPerTask} (each is one task in the plan)`],
          ["Staff cost and FTE", `${fmt.money(inputs.staffHourlyUsd)}/hour (sample, verify); ${fmt.number(inputs.fteHoursPerMonth)} hours = 1 FTE`],
        ]
      : [
          ["Requests in month 1", fmt.number(Math.round(result.volume.requestsPerMonth))],
          ["Conversations in month 1", fmt.number(Math.round(result.volume.conversationsPerMonth))],
        ]),
    ["Average tokens per request", `${fmt.number(Math.round(result.volume.avgInTokens))} in / ${fmt.number(Math.round(result.volume.avgOutTokens))} out`],
    ["Peak-hour share of daily traffic", `${inputs.peakSharePct}%`],
    ["Monthly growth", `${inputs.growthPct}% for ${fmt.number(inputs.growthMonths)} months, then flat`],
    ...(result.valueKind === "agent" ? [] : [["Conversations reaching a human today", `${inputs.humanSharePct}% (support savings count only these)`]]),
    ["Engineer hourly cost", `${fmt.money(inputs.engineerHourlyUsd)}${sampleTag(region?.engineer_hourly_is_sample && inputs.engineerHourlyUsd === region.engineer_hourly_usd)}`],
    ["Self-hosted model (assumption)", `${model.label}: needs ~${model.vram_gb_needed} GB VRAM (${model.why})`],
    ["Self-hosted GPUs in month 1", c ? `${c.gpus} (capacity headroom ×${sh.headroom}${inputs.useCase === "voice_agent" && inputs.latency === "realtime" ? `, real-time voice overhead ×${sh.realtime_voice_overhead}` : ""}${inputs.uptime === "high_availability" ? ", minimum 2 for high availability" : ""})` : "—"],
    ["Hybrid share on self-hosted", hybridText(result)],
    ["Tax", taxText(result.tax)],
    ["Build hours (A / B / C / D)", OPTION_IDS.map((id) => inputs.buildHours[id]).join(" / ")],
    ["Maintenance hours per month (A / B / C / D)", OPTION_IDS.map((id) => inputs.maintenanceHours[id]).join(" / ")],
    ["Business profile", result.profile.replace(/_/g, " ")],
    ["Cost vs non-cost weight", `${(result.costWeight * 100).toFixed(0)}% / ${(100 - result.costWeight * 100).toFixed(0)}%`],
    ["Exchange rates", `${data.fx.source}, ${data.fx.as_of}${data.fx.is_sample ? " (sample)" : ""}. AED from its 3.6725 USD peg.`],
    ["Note on open models", sh.open_model_note],
  ];
  setTable($("assump-table"), ["Assumption", "Value"], rows, { numericFrom: 99 });

  const priceRows = result.pricesUsed.map((p) => {
    const link = /^https:\/\//.test(p.source_url) ? el("a", { href: p.source_url, rel: "noopener" }, new URL(p.source_url).hostname) : p.source_url;
    return [p.label, priceValue(p, fmt), link, p.last_verified, p.is_sample ? "Sample" : "Verified", p.notes || ""];
  });
  setTable($("prices-table"), ["Item", "Price (USD source)", "Source", "Last verified", "Status", "Notes"], priceRows, { numericFrom: 99 });
}

function hybridText(result) {
  const h = result.hybrid;
  if (h.mode === "data_must_stay") return "100% (data must stay on company infrastructure)";
  if (h.mode === "manual") return `${h.pct}% (set by you)`;
  const others = h.rows.filter((r) => r.pct !== h.pct).sort((a, b) => a.tco36 - b.tco36)[0];
  return `${h.pct}%, the cheapest 36-month split between 10% and 90%${others ? ` (next best: ${others.pct}%)` : ""}`;
}

function taxText(tax) {
  if (!tax.components.length) return `${tax.label}: no tax added`;
  const parts = tax.components.map((c) => `${c.name}${c.recoverable ? " (reclaimable" + (c.counted ? ", but not by you)" : ")") : " (not reclaimable)"}${c.isSample ? " [sample, verify]" : ""}`);
  const added = tax.nonRecoverablePct > 0 ? `${+tax.nonRecoverablePct.toFixed(3)}% added to vendor spend (not to labour)` : "nothing added to costs";
  return `${tax.label}: ${parts.join(", ")}. ${added}.`;
}

function priceValue(p, fmt) {
  const usd = (x, d) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: d }).format(x);
  switch (p.unit) {
    case "usd_per_million_tokens": return `${usd(p.input_price, 2)} in / ${usd(p.output_price, 2)} out per 1M tokens`;
    case "usd_per_hour": return `${usd(p.price, 2)} / hour`;
    case "usd_per_month": return `${usd(p.price, 2)} / month`;
    case "usd_per_minute": return `${usd(p.price, 4)} / minute`;
    case "usd_per_1k_characters": return `${usd(p.price, 3)} / 1k characters`;
    case "output_tokens_per_second": return `${fmt.number(p.value)} output tokens/s (assumption)`;
    case "usd_per_seat_month": return `${usd(p.per_seat_price, 2)} / seat / month (min ${p.min_seats})`;
    case "usd_per_month_for_included_conversations": return `${usd(p.monthly_price, 2)} / month for ${fmt.number(p.included_conversations)} conversations`;
    case "usd_per_resolution_plus_seats": return `${usd(p.per_resolution_price, 2)} / resolution + ${usd(p.per_seat_price, 2)} / seat`;
    case "usd_per_second": return `${usd(p.price, 2)} / second of video`;
    case "usd_per_image": return `${usd(p.price, 3)} / image`;
    case "usd_per_request": return `${usd(p.post_price, 3)} / post, ${usd(p.owned_read_price, 3)} / owned read`;
    case "usd_per_month_for_task_tier": return `from ${usd(p.task_tiers[0].annual, 2)} / month (annual) for ${fmt.number(p.task_tiers[0].tasks)} tasks`;
    default: return p.unit;
  }
}
