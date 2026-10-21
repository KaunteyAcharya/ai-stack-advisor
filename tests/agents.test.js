import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AGENT_USE_CASES, agentTokens } from "../engine/agents.js";
import { withDefaults, useCaseDefaults } from "../engine/inputs.js";
import { volume, apiMonthly, saasMonthly, selfhostMonthly, hybridMonthly, llmCostPerRequest } from "../engine/costs.js";
import { agentValue } from "../engine/value.js";
import { analyze } from "../engine/recommend.js";
import { TEST_PRICES } from "./fixtures.js";

const usecases = JSON.parse(readFileSync(new URL("../data/usecases.json", import.meta.url)));
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const agent = (useCase, extra = {}) =>
  withDefaults({ ...useCaseDefaults(useCase, usecases), growthPct: 0, engineerHourlyUsd: 10, staffHourlyUsd: 20, region: "US", ...extra });

test("usecases.json agents match the engine list and have every field", () => {
  const fromData = Object.entries(usecases.usecases).filter(([, u]) => u.kind === "agent").map(([k]) => k);
  assert.deepEqual(fromData.sort(), [...AGENT_USE_CASES].sort());
  for (const id of AGENT_USE_CASES) {
    for (const [k, v] of Object.entries(useCaseDefaults(id, usecases))) assert.notEqual(v, undefined, `${id}.${k}`);
  }
});

test("context grows each step: average and total input tokens", () => {
  const t = agentTokens({ stepsPerTask: 4, inTokensPerStep: 2500, contextGrowthPerStep: 400, outTokensPerStep: 300 });
  assert.equal(t.avgInTokens, 3100);
  assert.equal(t.totalInTokens, 12_400);
  assert.equal(t.callsPerTask, 4);
});

test("agent volume: tasks × steps calls; OCR pages per task", () => {
  const v = volume(agent("invoice_processing", { tasksPerMonth: 1000 }));
  assert.equal(v.tasks, 1000);
  assert.equal(v.requestsPerMonth, 4000);
  assert.equal(v.pagesPerMonth, 2000);
});

test("batch prices for batch-friendly agents; workflow SaaS uses standard prices", () => {
  const inv = agent("invoice_processing", { tasksPerMonth: 1000 });
  const v = volume(inv);
  const batch = apiMonthly(inv, TEST_PRICES);
  close(batch.llmMonthly, v.requestsPerMonth * llmCostPerRequest(v.avgInTokens, v.avgOutTokens, { input_price: 0.15, output_price: 1.25 }));
  close(apiMonthly({ ...inv, useBatch: false }, TEST_PRICES).llmMonthly, 2 * batch.llmMonthly);
  const saasLlm = saasMonthly(inv, TEST_PRICES).lines[0].basis.find((b) => b.unit.startsWith("LLM")).rate;
  close(saasLlm, llmCostPerRequest(v.avgInTokens, v.avgOutTokens, TEST_PRICES.llm.good));
});

test("workflow SaaS: smallest task tier that fits; billing period changes the price", () => {
  const inv = agent("invoice_processing", { tasksPerMonth: 1000, saasStepsPerTask: 4 }); // 4,000 workflow tasks
  const annual = saasMonthly(inv, TEST_PRICES);
  assert.equal(annual.tier, "zap");
  assert.equal(annual.lines[0].basis[0].rate, 129);
  assert.equal(saasMonthly({ ...inv, saasBilling: "monthly" }, TEST_PRICES).lines[0].basis[0].rate, 193.5);
  assert.ok(saasMonthly({ ...inv, tasksPerMonth: 1_000_000 }, TEST_PRICES).flags[0].includes("exceeds plan limit"));
});

test("content engine: video, images, X posts and replies on own posts, same for every option", () => {
  const c = agent("content_engine", { videosPerMonth: 10, secondsPerVideo: 30, videoTier: "fast", imagesPerMonth: 20, xPostsPerMonth: 10, repliesPerMonth: 100, xRepliesSharePct: 50 });
  const r = apiMonthly(c, TEST_PRICES);
  close(r.lines.find((l) => l.label.startsWith("AI video")).usd, 300 * 0.1);
  close(r.lines.find((l) => l.label.startsWith("AI images")).usd, 20 * 0.067);
  close(r.lines.find((l) => l.label.startsWith("X API")).usd, (10 + 50) * 0.015 + 50 * 0.001);
  assert.equal(volume(c).requestsPerMonth, c.tasksPerMonth * c.stepsPerTask + 100);
  for (const fn of [selfhostMonthly, saasMonthly]) close(fn(c, TEST_PRICES).lines.find((l) => l.label.startsWith("AI video")).usd, 30);
  close(hybridMonthly(c, TEST_PRICES, 0, 1, 0.5).lines.filter((l) => l.label.startsWith("AI video")).reduce((s, l) => s + l.usd, 0), 30);
});

test("stock report: market data feed line, overridable", () => {
  const s = agent("stock_report");
  const feed = (r) => r.lines.find((l) => l.label === "Market data feed").usd;
  assert.equal(feed(apiMonthly(s, TEST_PRICES)), 199);
  assert.equal(feed(apiMonthly({ ...s, marketDataMonthlyUsd: 1500 }, TEST_PRICES)), 1500);
});

const valueInputs = { tasksPerMonth: 2000, humanMinutesPerTask: 6, successPct: 80, reviewPct: 20, reviewMinutes: 2, errorPct: 1, costPerError: 20, staffHourly: 20, fteHoursPerMonth: 160, optionMonthly: 500, oneTime: 3000 };

test("agent value: hours saved, review time, errors, FTE, payback", () => {
  const v = agentValue(valueInputs);
  close(v.hoursSaved, 160); // 2000 × 0.8 × 6 / 60
  close(v.reviewHours, (2000 * 0.2 * 2) / 60);
  close(v.netHours, 160 - 400 / 30);
  close(v.fte, v.netHours / 160);
  close(v.errorCost, 400);
  close(v.benefit, v.netHours * 20 - 400);
  close(v.net, v.benefit - 500);
  close(v.paybackMonths, 3000 / v.net);
  assert.deepEqual(v.sensitivity.map((r) => r.successPct), [50, 70, 90]);
});

test("at the break-even success rate, benefit equals AI cost", () => {
  const v = agentValue(valueInputs);
  close(agentValue({ ...valueInputs, successPct: v.breakevenSuccessPct }).net, 0, 1e-6);
});

test("analyze: agents are valued on time saved, in hours or FTE", () => {
  const r = analyze(agent("invoice_processing"), TEST_PRICES, { curve: false });
  assert.equal(r.valueKind, "agent");
  assert.equal(r.profile, "automation");
  assert.equal(r.deflectionSensitivity.length, 0);
  assert.ok(r.explanation.some((s) => s.includes("hours a month")));
  assert.ok(!r.excluded.some((x) => x.id === "A"), "workflow SaaS is available for agents");
  const f = analyze(agent("invoice_processing", { valueUnit: "fte" }), TEST_PRICES, { curve: false });
  assert.ok(f.explanation.some((s) => /about \d+(\.\d+)? FTE/.test(s)));
});

test("workings add up for every agent and option", () => {
  for (const id of AGENT_USE_CASES) {
    const i = agent(id, { ocrCostPerPageUsd: 0.0015, externalFeePerTaskUsd: 0.05 });
    for (const r of [apiMonthly(i, TEST_PRICES), selfhostMonthly(i, TEST_PRICES), saasMonthly(i, TEST_PRICES), hybridMonthly(i, TEST_PRICES, 0, 1, 0.5)]) {
      for (const l of r.lines) if (l.basis) close(l.basis.reduce((t, b) => t + b.qty * b.rate, 0), l.usd);
    }
  }
});
