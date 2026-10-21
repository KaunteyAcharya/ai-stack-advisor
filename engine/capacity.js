// GPU sizing for self-hosting.
// Chain (data/selfhost.json): quality need → model size class → VRAM needed → GPU class → throughput.

export const HEADROOM = 1.3;

/**
 * Picks the model size class and the cheapest GPU class with enough VRAM.
 * @returns { modelClass, model, gpuClass }
 */
export function selectGpu(quality, selfhost, gpus) {
  const modelClass = selfhost.quality_to_model[quality] || selfhost.quality_to_model.good;
  const model = selfhost.model_classes[modelClass];
  const fits = Object.values(gpus)
    .filter((g) => g.vram_gb >= model.vram_gb_needed)
    .sort((a, b) => a.price - b.price);
  if (!fits.length) throw new Error(`No GPU class has ${model.vram_gb_needed} GB VRAM`);
  return { modelClass, model, gpuClass: fits[0].gpu_class };
}

/**
 * gpus = max(1, ceil(peak_rps × out_tokens × headroom × overhead / gpu_tokens_per_sec)),
 * and at least 2 for high availability. `overhead` is extra capacity (e.g. 1.3 for real-time voice).
 */
export function gpusNeeded({ peakRequestsPerSec, outTokens, gpuTokensPerSec, highAvailability = false, headroom = HEADROOM, overhead = 1 }) {
  const requiredTokPerSec = peakRequestsPerSec * outTokens;
  let gpus = Math.max(1, Math.ceil((requiredTokPerSec * headroom * overhead) / gpuTokensPerSec));
  if (highAvailability) gpus = Math.max(gpus, 2);
  return gpus;
}
