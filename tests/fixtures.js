// Fixed test prices and rates, so tests don't break when real prices change.
import { indexPrices } from "../engine/prices.js";

const e = (o) => ({ label: o.id, source_url: "test", last_verified: "2026-01-01", is_sample: false, ...o });

export const TEST_FX = {
  base: "USD",
  as_of: "2026-01-01",
  source_url: "test",
  rates: { USD: 1, INR: 80, EUR: 0.9, GBP: 0.8, CHF: 0.85, CAD: 1.35, AUD: 1.5, AED: 3.6725 },
};

export const TEST_PRICE_ENTRIES = [
  e({ id: "llm_b", category: "llm_api", tier: "budget", unit: "usd_per_million_tokens", input_price: 0.1, output_price: 0.4 }),
  e({ id: "llm_m", category: "llm_api", tier: "mid", unit: "usd_per_million_tokens", input_price: 0.3, output_price: 2.5, batch_input_price: 0.15, batch_output_price: 1.25 }),
  e({ id: "llm_p", category: "llm_api", tier: "premium", unit: "usd_per_million_tokens", input_price: 1.25, output_price: 10 }),
  e({ id: "gpu_l4", category: "gpu_rental", gpu_class: "l4", vram_gb: 24, unit: "usd_per_hour", price: 0.8 }),
  e({ id: "gpu_a100", category: "gpu_rental", gpu_class: "a100_80gb", vram_gb: 80, unit: "usd_per_hour", price: 2 }),
  e({ id: "thr_l4", category: "gpu_throughput", gpu_class: "l4", unit: "output_tokens_per_second", value: 400 }),
  e({ id: "thr_a100", category: "gpu_throughput", gpu_class: "a100_80gb", unit: "output_tokens_per_second", value: 600 }),
  e({ id: "mdb", category: "managed_db", unit: "usd_per_month", price: 25 }),
  e({ id: "sdb", category: "self_managed_db", unit: "usd_per_month", price: 24 }),
  e({ id: "vdb", category: "vector_db", unit: "usd_per_month", price: 50 }),
  e({ id: "host", category: "hosting", unit: "usd_per_month", price: 12 }),
  e({ id: "stor", category: "storage", unit: "usd_per_month", price: 20 }),
  e({ id: "mon", category: "monitoring", unit: "usd_per_month", price: 30 }),
  e({ id: "stt", category: "voice_stt", unit: "usd_per_minute", price: 0.005 }),
  e({ id: "tts", category: "voice_tts", unit: "usd_per_1k_characters", price: 0.03 }),
  e({ id: "tel_us", category: "telephony", region: "US", unit: "usd_per_minute", price: 0.0085 }),
  e({ id: "tel_def", category: "telephony", region: "default", unit: "usd_per_minute", price: 0.01 }),
  e({ id: "seat", category: "saas_chatbot", pricing_type: "per_seat", use_cases: ["internal_copilot"], unit: "x", per_seat_price: 25, min_seats: 2, max_seats: 150 }),
  e({ id: "conv50", category: "saas_chatbot", pricing_type: "per_conversation", use_cases: ["chatbot"], unit: "x", monthly_price: 30, max_conversations_per_month: 50 }),
  e({ id: "conv1k", category: "saas_chatbot", pricing_type: "per_conversation", use_cases: ["chatbot"], unit: "x", monthly_price: 400, max_conversations_per_month: 1000 }),
  e({ id: "res", category: "saas_chatbot", pricing_type: "per_resolution", use_cases: ["chatbot", "voice_agent"], unit: "x", per_seat_price: 29, min_seats: 1, per_resolution_price: 0.99 }),
  e({ id: "veo_fast", category: "video_generation", video_tier: "fast", unit: "usd_per_second", price: 0.1 }),
  e({ id: "veo_lite", category: "video_generation", video_tier: "lite", unit: "usd_per_second", price: 0.05 }),
  e({ id: "img", category: "image_generation", unit: "usd_per_image", price: 0.067 }),
  e({ id: "xapi", category: "social_api", unit: "usd_per_request", post_price: 0.015, owned_read_price: 0.001 }),
  e({ id: "mkt", category: "market_data", unit: "usd_per_month", price: 199 }),
  e({
    id: "zap",
    category: "saas_chatbot",
    pricing_type: "per_task",
    use_cases: ["invoice_processing", "lead_qualification", "report_generation", "ticket_triage", "stock_report", "content_engine"],
    unit: "x",
    task_tiers: [
      { tasks: 750, annual: 20, monthly: 30 },
      { tasks: 10000, annual: 129, monthly: 193.5 },
      { tasks: 2000000, annual: 3389, monthly: 5099 },
    ],
  }),
];

// Test chain: basic/good → small model (fits L4), best_available → large model (needs A100).
export const TEST_SELFHOST = {
  quality_to_model: { basic: "small", good: "small", best_available: "large" },
  model_classes: { small: { vram_gb_needed: 22 }, large: { vram_gb_needed: 64 } },
  headroom: 1.3,
  realtime_voice_overhead: 1.3,
};

export const TEST_PRICES = indexPrices({ entries: TEST_PRICE_ENTRIES }, TEST_FX, TEST_SELFHOST);
