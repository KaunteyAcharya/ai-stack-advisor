// Growth projection and total cost of ownership.

import { monthlyCosts, oneTimeCost } from "./costs.js";
import { OPTION_IDS } from "./inputs.js";

/** Discount factor for month m (0-based), costs paid at the end of each month, annual rate in %. */
export function pvFactor(m, annualRatePct = 0) {
  return 1 / Math.pow(1 + annualRatePct / 100, (m + 1) / 12);
}

/**
 * Projects every option over `months` months with volume growth.
 * TCO_n = one_time + Σ monthly_cost(m) for m = 0..n-1.
 * Monthly cost is recomputed each month, so the GPU count can step up.
 */
export function projectTco(inputs, prices, { months = 36, shareSelf } = {}) {
  const result = {};
  for (const id of OPTION_IDS) {
    result[id] = { oneTime: oneTimeCost(inputs, id), monthly: [], cumulative: [], gpus: [] };
  }
  for (let m = 0; m < months; m++) {
    const costs = monthlyCosts(inputs, prices, m, 1, { shareSelf });
    for (const id of OPTION_IDS) {
      const r = result[id];
      r.monthly.push(costs[id].total);
      r.gpus.push(costs[id].gpus ?? 0);
      r.cumulative.push((m === 0 ? r.oneTime : r.cumulative[m - 1]) + costs[id].total);
    }
  }
  for (const id of OPTION_IDS) {
    const r = result[id];
    r.tco12 = r.cumulative[Math.min(11, months - 1)];
    r.tco36 = r.cumulative[months - 1];
    // Present value: the one-time cost is paid now, monthly costs are discounted.
    r.pv36 = r.oneTime + r.monthly.reduce((s, x, m) => s + x * pvFactor(m, inputs.discountRatePct ?? 0), 0);
  }
  return result;
}

/** TCO from a plain array of monthly costs (used by tests and docs). */
export function tcoFromMonthly(oneTime, monthly, n) {
  return oneTime + monthly.slice(0, n).reduce((s, x) => s + x, 0);
}
