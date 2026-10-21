// Turns data/prices.json into a lookup the cost functions can use.
// Entries quoted in another currency are converted to USD here.

const PRICE_FIELDS = ["input_price", "output_price", "price", "per_seat_price", "per_resolution_price"];

/**
 * `selfhost` is data/selfhost.json (model size → VRAM → GPU chain assumptions);
 * `taxes` is data/taxes.json (indirect tax per region), optional.
 */
export function indexPrices(pricesData, fx, selfhost, taxes = null) {
  const byId = {};
  for (const raw of pricesData.entries) {
    const entry = { ...raw };
    if (entry.currency && entry.currency !== "USD") {
      const rate = fx.rates[entry.currency];
      if (!rate) throw new Error(`No FX rate for ${entry.currency} (price ${entry.id})`);
      for (const f of PRICE_FIELDS) if (typeof entry[f] === "number") entry[f] = entry[f] / rate;
      entry.converted_note = `Converted from ${entry.currency} to USD at reference rate dated ${fx.as_of}`;
    }
    byId[entry.id] = entry;
  }
  const all = Object.values(byId);
  const one = (category) => all.find((e) => e.category === category);
  return {
    byId,
    llm: {
      basic: all.find((e) => e.category === "llm_api" && e.tier === "budget"),
      good: all.find((e) => e.category === "llm_api" && e.tier === "mid"),
      best_available: all.find((e) => e.category === "llm_api" && e.tier === "premium"),
    },
    gpu: Object.fromEntries(all.filter((e) => e.category === "gpu_rental").map((e) => [e.gpu_class, e])),
    throughput: Object.fromEntries(all.filter((e) => e.category === "gpu_throughput").map((e) => [e.gpu_class, e])),
    managedDb: one("managed_db"),
    selfManagedDb: one("self_managed_db"),
    vectorDb: one("vector_db"),
    hosting: one("hosting"),
    storage: one("storage"),
    monitoring: one("monitoring"),
    stt: one("voice_stt"),
    tts: one("voice_tts"),
    telephony: Object.fromEntries(all.filter((e) => e.category === "telephony").map((e) => [e.region, e])),
    saasTiers: all.filter((e) => e.category === "saas_chatbot"),
    video: Object.fromEntries(all.filter((e) => e.category === "video_generation").map((e) => [e.video_tier, e])),
    image: one("image_generation"),
    socialX: one("social_api"),
    marketData: one("market_data"),
    selfhost,
    taxes,
  };
}
