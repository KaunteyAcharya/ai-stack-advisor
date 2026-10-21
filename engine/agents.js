// Workflow agents: tasks that run several LLM steps, with context growing at each step,
// plus the external costs some workflows carry (OCR pages, per-task API fees, media
// generation, social APIs, market data).

export const AGENT_USE_CASES = [
  "invoice_processing",
  "lead_qualification",
  "report_generation",
  "ticket_triage",
  "stock_report",
  "content_engine",
];

export const isAgent = (inputs) => AGENT_USE_CASES.includes(inputs.useCase);

/** Internal tools: valued on staff time saved per request, not on sales. */
export const INTERNAL_USE_CASES = ["data_assistant", "internal_copilot"];
export const isInternal = (inputs) => INTERNAL_USE_CASES.includes(inputs.useCase);
/** Use cases whose value is time saved (agents and internal tools). */
export const valuedOnTime = (inputs) => isAgent(inputs) || isInternal(inputs);

/**
 * Tokens per LLM call for one task of `steps` steps. Step i (1-based) reads the base
 * prompt plus everything produced so far: in_i = base + (i − 1) × growth.
 *   total input  = steps × base + growth × steps × (steps − 1) / 2
 *   average input per call = base + growth × (steps − 1) / 2
 */
export function agentTokens({ stepsPerTask, inTokensPerStep, contextGrowthPerStep, outTokensPerStep }) {
  const steps = Math.max(1, stepsPerTask);
  return {
    callsPerTask: steps,
    avgInTokens: inTokensPerStep + (contextGrowthPerStep * (steps - 1)) / 2,
    outTokens: outTokensPerStep,
    totalInTokens: steps * inTokensPerStep + (contextGrowthPerStep * steps * (steps - 1)) / 2,
  };
}

const basis = (qty, unit, rate) => [{ qty, unit, rate }];

/**
 * Costs every option pays regardless of where the LLM runs (USD per month, month m via growth g):
 * OCR, per-task external fees, AI video and images, X API calls, market data.
 * Media generation is priced through vendor APIs for all options.
 */
export function workflowExtraLines(inputs, prices, v) {
  const lines = [];
  const priceIds = [];
  if (v.pagesPerMonth > 0 && inputs.ocrCostPerPageUsd > 0) {
    lines.push({ label: "OCR (assumption per page)", usd: v.pagesPerMonth * inputs.ocrCostPerPageUsd, basis: basis(v.pagesPerMonth, "pages", inputs.ocrCostPerPageUsd) });
  }
  if (!isAgent(inputs)) return { lines, priceIds };

  if (inputs.externalFeePerTaskUsd > 0) {
    lines.push({ label: "External API fees (assumption per task)", usd: v.tasks * inputs.externalFeePerTaskUsd, basis: basis(v.tasks, "tasks", inputs.externalFeePerTaskUsd) });
  }
  if (inputs.useCase === "content_engine") {
    const video = prices.video[inputs.videoTier] || prices.video.fast;
    const seconds = inputs.videosPerMonth * inputs.secondsPerVideo * v.growth;
    if (seconds > 0) {
      lines.push({ label: `AI video (${video.label})`, usd: seconds * video.price, basis: basis(seconds, "video seconds", video.price) });
      priceIds.push(video.id);
    }
    const images = inputs.imagesPerMonth * v.growth;
    if (images > 0) {
      lines.push({ label: `AI images (${prices.image.label})`, usd: images * prices.image.price, basis: basis(images, "images", prices.image.price) });
      priceIds.push(prices.image.id);
    }
    const x = prices.socialX;
    const xPosts = inputs.xPostsPerMonth * v.growth;
    const xReplies = inputs.repliesPerMonth * (inputs.xRepliesSharePct / 100) * v.growth;
    if (xPosts + xReplies > 0) {
      lines.push({
        label: "X API (posts and replies on your own posts)",
        usd: (xPosts + xReplies) * x.post_price + xReplies * x.owned_read_price,
        basis: [...basis(xPosts + xReplies, "posts/replies", x.post_price), ...basis(xReplies, "comment reads", x.owned_read_price)],
      });
      priceIds.push(x.id);
    }
  }
  if (inputs.useCase === "stock_report") {
    const fee = inputs.marketDataMonthlyUsd ?? prices.marketData.price;
    lines.push({ label: "Market data feed", usd: fee, basis: basis(1, "month", fee) });
    if (inputs.marketDataMonthlyUsd == null) priceIds.push(prices.marketData.id);
  }
  return { lines, priceIds };
}
