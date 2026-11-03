// GPU sizing for self-hosting.
// Chain (data/selfhost.json): quality need → model size class → VRAM needed → GPU class → throughput.
//
// A request uses the GPU twice: reading the prompt (prefill, compute-bound) and writing the answer
// (decode). Both share the same GPU time. Requests in flight also hold their KV cache in GPU memory,
// so long prompts can need more GPUs for memory than for compute.

export const HEADROOM = 1.3;

/** GB of GPU memory left for the KV cache once the model weights are loaded (0 if not modelled). */
export function kvRoomGb(gpu, model, selfhost) {
  if (!(model?.weights_gb > 0)) return 0;
  return Math.max(0, gpu.vram_gb * (selfhost.usable_vram_share ?? 0.9) - model.weights_gb);
}

/** Tokens of context one GPU can hold in its KV cache (Infinity if not modelled). */
export function kvTokensPerGpu(gpu, model, selfhost) {
  const room = kvRoomGb(gpu, model, selfhost);
  return room > 0 && model.kv_mb_per_token > 0 ? (room * 1024) / model.kv_mb_per_token : Infinity;
}

/**
 * Picks the model size class and the cheapest GPU class with enough VRAM for the weights and,
 * where possible, one request's full context (`contextTokens`) in its KV cache.
 * @returns { modelClass, model, gpuClass, contextFits }
 */
export function selectGpu(quality, selfhost, gpus, contextTokens = 0) {
  const modelClass = selfhost.quality_to_model[quality] || selfhost.quality_to_model.good;
  const model = selfhost.model_classes[modelClass];
  const fits = Object.values(gpus)
    .filter((g) => g.vram_gb >= model.vram_gb_needed)
    .sort((a, b) => a.price - b.price);
  if (!fits.length) throw new Error(`No GPU class has ${model.vram_gb_needed} GB VRAM`);
  const holds = fits.find((g) => kvTokensPerGpu(g, model, selfhost) >= contextTokens);
  if (holds) return { modelClass, model, gpuClass: holds.gpu_class, contextFits: true };
  const roomiest = fits.reduce((a, b) => (kvTokensPerGpu(b, model, selfhost) > kvTokensPerGpu(a, model, selfhost) ? b : a));
  return { modelClass, model, gpuClass: roomiest.gpu_class, contextFits: false };
}

/**
 * GPU load at peak, in GPUs (before headroom):
 *   prefill = peak_rps × uncached_prompt_tokens / prefill_tokens_per_sec × overhead
 *   decode  = peak_rps × out_tokens / decode_tokens_per_sec × overhead
 *   memory  = concurrent × (in_tokens + out_tokens / 2) × kv_mb_per_token / 1024 / kv_gb_per_gpu
 *   concurrent = peak_rps × (prompt time + out_tokens / per-stream speed)          (Little's law)
 * A term is 0 when its figures are not in the data. Repeated prompt prefixes (`cachedShare`) are
 * served from the prefix cache, so they skip prefill but still occupy memory.
 */
export function gpuLoad({ peakRequestsPerSec, outTokens, gpuTokensPerSec, inTokens = 0, prefillTokensPerSec = 0, cachedShare = 0, overhead = 1, kvGbPerGpu = 0, kvMbPerToken = 0, streamTokensPerSec = 0 }) {
  const promptSeconds = prefillTokensPerSec > 0 ? (inTokens * (1 - cachedShare)) / prefillTokensPerSec : 0;
  const prefill = peakRequestsPerSec * promptSeconds * overhead;
  const decode = (peakRequestsPerSec * outTokens * overhead) / gpuTokensPerSec;
  const concurrent = peakRequestsPerSec * (promptSeconds + (streamTokensPerSec > 0 ? outTokens / streamTokensPerSec : 0));
  const memory = kvGbPerGpu > 0 && kvMbPerToken > 0 ? (concurrent * (inTokens + outTokens / 2) * kvMbPerToken) / 1024 / kvGbPerGpu : 0;
  return { prefill, decode, memory, concurrent };
}

/** Whole GPUs for a load: max(1, ceil(max(prefill + decode, memory) × headroom)), and at least 2 for high availability. */
export function gpusForLoad(load, { headroom = HEADROOM, highAvailability = false } = {}) {
  const compute = load.prefill + load.decode;
  let gpus = Math.max(1, Math.ceil(Math.max(compute, load.memory) * headroom - 1e-9));
  if (highAvailability) gpus = Math.max(gpus, 2);
  const bound = load.memory > compute ? "memory" : load.prefill > load.decode ? "prefill" : "decode";
  return { gpus, bound };
}

/** GPU count and what limits it ("prefill", "decode" or "memory"). See gpuLoad for the formulas. */
export function gpuSizing({ highAvailability = false, headroom = HEADROOM, ...load }) {
  const l = gpuLoad(load);
  return { ...l, ...gpusForLoad(l, { headroom, highAvailability }) };
}

/**
 * gpus = max(1, ceil(peak load × headroom)), and at least 2 for high availability. With only output
 * tokens given, this is ceil(peak_rps × out_tokens × headroom × overhead / gpu_tokens_per_sec).
 * `overhead` is extra capacity (e.g. 1.3 for real-time voice).
 */
export function gpusNeeded(args) {
  return gpuSizing(args).gpus;
}
