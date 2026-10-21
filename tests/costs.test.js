import { test } from "node:test";
import assert from "node:assert/strict";
import { volume, llmCostPerRequest, apiMonthly, selfhostMonthly, saasMonthly, hybridMonthly, voiceMonthly, oneTimeCost } from "../engine/costs.js";
import { withDefaults } from "../engine/inputs.js";
import { indexPrices } from "../engine/prices.js";
import * as costsModule from "../engine/costs.js";
import { TEST_PRICES, TEST_FX } from "./fixtures.js";

const base = withDefaults({ usersPerDay: 500, requestsPerUser: 5, inTokens: 1500, outTokens: 400, growthPct: 0, quality: "good", engineerHourlyUsd: 10, rag: false, region: "US" });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("volume: requests per month and peak rps", () => {
  const v = volume(base, 0);
  assert.equal(v.requestsPerMonth, 75_000);
  assert.equal(v.conversationsPerMonth, 15_000);
  close(v.peakRequestsPerSec, (2500 * 0.15) / 3600);
});

test("volume grows by (1+g)^m", () => {
  const v = volume({ ...base, growthPct: 10 }, 2);
  close(v.requestsPerMonth, 75_000 * 1.21);
});

test("llm cost per request", () => {
  close(llmCostPerRequest(1500, 400, { input_price: 0.3, output_price: 2.5 }), 0.00145);
});

test("API monthly = LLM + managed DB + hosting + maintenance", () => {
  const r = apiMonthly(base, TEST_PRICES);
  close(r.llmMonthly, 108.75);
  close(r.total, 108.75 + 25 + 12 + 10 * 10);
});

test("API monthly adds vector DB when RAG is on", () => {
  close(apiMonthly({ ...base, rag: true }, TEST_PRICES).total - apiMonthly(base, TEST_PRICES).total, 50);
});

test("self-hosted monthly: one GPU at low volume", () => {
  const r = selfhostMonthly(base, TEST_PRICES);
  assert.equal(r.gpus, 1);
  close(r.gpuMonthly, 584);
  close(r.total, 584 + 24 + 20 + 30 + 30 * 10);
});

test("SaaS: cheapest viable plan; per-conversation tier while volume fits", () => {
  const r = saasMonthly({ ...base, usersPerDay: 1, seats: 1 }, TEST_PRICES); // 30 conversations
  assert.equal(r.tier, "conv50");
  close(r.lines[0].usd, 30);
});

test("SaaS: per-resolution = base seats + resolved conversations × price", () => {
  const r = saasMonthly({ ...base, seats: 3, deflectionPct: 50 }, TEST_PRICES); // 15,000 conversations > tier limits
  assert.equal(r.tier, "res");
  close(r.lines[0].usd, 3 * 29 + 15_000 * 0.5 * 0.99);
});

test("SaaS: per-seat plan applies minimum seats and only to its use cases", () => {
  const r = saasMonthly({ ...base, useCase: "internal_copilot", seats: 1, usersPerDay: 1 }, TEST_PRICES);
  assert.equal(r.tier, "seat");
  close(r.lines[0].usd, 2 * 25);
  // every daily user of an internal tool needs a seat
  close(saasMonthly({ ...base, useCase: "internal_copilot", seats: 3, usersPerDay: 40 }, TEST_PRICES).lines[0].usd, 40 * 25);
  const tooMany = saasMonthly({ ...base, useCase: "internal_copilot", seats: 200, usersPerDay: 1 }, TEST_PRICES);
  assert.ok(tooMany.flags[0].includes("exceeds plan limit"));
});

test("SaaS: no plan for this use case → unavailable", () => {
  const r = saasMonthly({ ...base, useCase: "document_processing", docsPerMonth: 100 }, TEST_PRICES);
  assert.ok(r.unavailable);
});

test("document processing volume = documents, tokens = pages × tokens/page; chat only if toggled", () => {
  const doc = { ...base, useCase: "document_processing", docsPerMonth: 2000, pagesPerDoc: 5, tokensPerPage: 600, docOutTokens: 800 };
  const v = volume(doc);
  assert.equal(v.requestsPerMonth, 2000);
  assert.equal(v.avgInTokens, 3000);
  assert.equal(v.pagesPerMonth, 10_000);
  const chat = volume({ ...doc, chatOverDocs: true });
  assert.equal(chat.requestsPerMonth, 2000 + 75_000);
  // LLM cost is exact: docs + chats priced separately
  const r = apiMonthly({ ...doc, chatOverDocs: true }, TEST_PRICES);
  close(r.llmMonthly, 2000 * llmCostPerRequest(3000, 800, TEST_PRICES.llm.good) + 75_000 * 0.00145);
});

test("OCR cost per page applies when set", () => {
  const doc = { ...base, useCase: "document_processing", docsPerMonth: 100, pagesPerDoc: 10, ocrCostPerPageUsd: 0.0015 };
  const line = apiMonthly(doc, TEST_PRICES).lines.find((l) => l.label.startsWith("OCR"));
  close(line.usd, 1.5);
});

test("GPU chain: best quality picks the large-VRAM GPU; realtime voice adds overhead", () => {
  assert.equal(selfhostMonthly({ ...base, quality: "best_available" }, TEST_PRICES).gpuClass, "a100_80gb");
  const busy = { ...base, usersPerDay: 50_000, useCase: "voice_agent", outTokens: 150 };
  const normal = selfhostMonthly(busy, TEST_PRICES).gpus;
  const realtime = selfhostMonthly({ ...busy, latency: "realtime" }, TEST_PRICES).gpus;
  assert.ok(realtime > normal, `${realtime} > ${normal}`);
});

test("hybrid: share on self-hosted plus the rest via API", () => {
  const r = hybridMonthly(base, TEST_PRICES, 0, 1, 0.7);
  const apiPart = r.lines.find((l) => l.label.startsWith("LLM API for"));
  close(apiPart.usd, 108.75 * 0.3);
});

test("voice add-on applies only to voice agents; self-hosted pays telephony only", () => {
  const voice = { ...base, useCase: "voice_agent", voiceMinutesPerConversation: 4, ttsCharsPerMinute: 750 };
  const hosted = voiceMonthly(voice, TEST_PRICES, 1000, false);
  close(hosted.total, 4000 * (0.0085 + 0.005 + 0.03 * 0.75));
  const self = voiceMonthly(voice, TEST_PRICES, 1000, true);
  close(self.total, 4000 * 0.0085);
  assert.equal(voiceMonthly(base, TEST_PRICES, 1000).total, 0);
});

test("one-time cost = (build + evaluation hours) × hourly", () => {
  assert.equal(oneTimeCost(base, "C"), (240 + 32) * 10);
});

test("prices quoted in another currency are converted to USD on load", () => {
  const p = indexPrices({ entries: [{ id: "x", category: "hosting", currency: "EUR", price: 9 }] }, TEST_FX, {});
  close(p.byId.x.price, 10);
  assert.ok(p.byId.x.converted_note.includes("EUR"));
});

test("SaaS billing: annual seat price where listed, monthly otherwise", () => {
  const plan = { pricing_type: "per_seat", per_seat_price: 25, per_seat_price_annual: 20, min_seats: 2 };
  const { seatPrice, saasPlanCost } = costsModule;
  assert.equal(seatPrice(plan, "annual"), 20);
  assert.equal(seatPrice(plan, "monthly"), 25);
  assert.equal(seatPrice({ per_seat_price: 29 }, "annual"), 29);
  assert.equal(saasPlanCost(plan, { ...base, seats: 4, usersPerDay: 1, saasBilling: "annual" }, 100).cost, 80);
  assert.equal(saasPlanCost(plan, { ...base, seats: 4, usersPerDay: 1, saasBilling: "monthly" }, 100).cost, 100);
});

test("every line's workings (quantity × rate) add up to the line amount", () => {
  const scenarios = [
    base,
    { ...base, useCase: "voice_agent", voiceMinutesPerConversation: 4, ttsCharsPerMinute: 750 },
    { ...base, useCase: "document_processing", docsPerMonth: 500, pagesPerDoc: 4, tokensPerPage: 600, docOutTokens: 800, ocrCostPerPageUsd: 0.0015 },
    { ...base, seats: 3, deflectionPct: 50 },
  ];
  for (const s of scenarios) {
    for (const r of [apiMonthly(s, TEST_PRICES), selfhostMonthly(s, TEST_PRICES), saasMonthly(s, TEST_PRICES), hybridMonthly(s, TEST_PRICES, 0, 1, 0.6)]) {
      for (const l of r.lines) {
        if (!l.basis) continue;
        const sumBasis = l.basis.reduce((t, b) => t + b.qty * b.rate, 0);
        close(sumBasis, l.usd, 1e-6);
      }
    }
  }
});
