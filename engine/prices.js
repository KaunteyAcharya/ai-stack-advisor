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
  // Quality need → each provider's model in that role (an entry may serve several tiers).
  const byTier = (entries) => {
    const at = (tier) => entries.find((e) => (e.tiers || [e.tier]).includes(tier));
    return { basic: at("budget"), good: at("mid"), best_available: at("premium") };
  };
  const llmEntries = all.filter((e) => e.category === "llm_api");
  const providerIds = [...new Set(llmEntries.map((e) => e.provider || "default"))];
  const llmByProvider = Object.fromEntries(providerIds.map((p) => [p, byTier(llmEntries.filter((e) => (e.provider || "default") === p))]));
  const defaultProvider = llmByProvider[pricesData.default_llm_provider] ? pricesData.default_llm_provider : providerIds[0];
  const providerLabels = Object.fromEntries((pricesData.llm_providers || []).map((p) => [p.id, p.label]));
  return {
    byId,
    llm: llmByProvider[defaultProvider],
    llmByProvider,
    llmProviders: providerIds.map((id) => ({ id, label: providerLabels[id] || id })),
    defaultLlmProvider: defaultProvider,
    openLlm: byTier(all.filter((e) => e.category === "llm_open_hosted")),
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
