// API vs self-hosting break-even, and the cost-vs-volume curve.

import { monthlyCosts, selfhostMonthly, apiMonthly, volume } from "./costs.js";
import { taxProfile } from "./tax.js";
import { OPTION_IDS } from "./inputs.js";

/** breakeven_requests_per_month = fixed_selfhost_monthly / api_cost_per_request */
export function breakevenRequests(fixedSelfhostMonthly, apiCostPerRequest) {
  if (apiCostPerRequest <= 0) return Infinity;
  return fixedSelfhostMonthly / apiCostPerRequest;
}

/**
 * Break-even for the user's scenario.
 * Fixed self-host = minimum GPUs (1, or 2 for HA) + ops labour + self-managed DB.
 * API cost per request = LLM cost + per-request share of variable voice costs (STT/TTS).
 * Non-reclaimable tax is added to external spend on both sides (not to labour).
 */
export function apiVsSelfhost(inputs, prices) {
  const tiny = selfhostMonthly(inputs, prices, 0, 1e-9, { includeVoice: false }); // minimum GPU count
  const t = 1 + taxProfile(inputs, prices.taxes).nonRecoverablePct / 100;
  const fixed = (tiny.gpuMonthly + prices.selfManagedDb.price) * t + tiny.opsMonthly;
  const api = apiMonthly(inputs, prices, 0);
  const v = volume(inputs, 0);
  const apiVoice = api.lines.filter((l) => l.label === "Speech-to-text" || l.label === "Text-to-speech").reduce((s, l) => s + l.usd, 0);
  const perRequest = (api.llmCostPerRequest + (v.requestsPerMonth > 0 ? apiVoice / v.requestsPerMonth : 0)) * t;
  return {
    fixedSelfhostMonthly: fixed,
    apiCostPerRequest: perRequest,
    breakevenRequestsPerMonth: breakevenRequests(fixed, perRequest),
    currentRequestsPerMonth: v.requestsPerMonth,
  };
}

/** Log-spaced volumes from `from` to `to` requests/month. */
export function logVolumes(from = 1_000, to = 10_000_000, points = 41) {
  const a = Math.log10(from);
  const b = Math.log10(to);
  return Array.from({ length: points }, (_, i) => Math.pow(10, a + ((b - a) * i) / (points - 1)));
}

/** Monthly cost of each option at each volume (month-1 prices, traffic scaled). */
export function costCurve(inputs, prices, { volumes = logVolumes(), shareSelf } = {}) {
  const base = volume(inputs, 0).requestsPerMonth;
  const series = Object.fromEntries(OPTION_IDS.map((id) => [id, []]));
  for (const vol of volumes) {
    const costs = monthlyCosts(inputs, prices, 0, vol / base, { shareSelf });
    for (const id of OPTION_IDS) series[id].push(costs[id].total);
  }
  return { volumes, series, crossovers: findCrossovers(volumes, series) };
}

/** Points where one option's curve crosses another's (interpolated in log-volume). */
export function findCrossovers(volumes, series) {
  const out = [];
  const ids = Object.keys(series);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = series[ids[i]];
      const b = series[ids[j]];
      for (let k = 1; k < volumes.length; k++) {
        const d0 = a[k - 1] - b[k - 1];
        const d1 = a[k] - b[k];
        if (d0 === 0 || Math.sign(d0) === Math.sign(d1)) continue;
        const t = d0 / (d0 - d1);
        const logV = Math.log10(volumes[k - 1]) + t * (Math.log10(volumes[k]) - Math.log10(volumes[k - 1]));
        out.push({
          between: [ids[i], ids[j]],
          requestsPerMonth: Math.pow(10, logV),
          costUsd: a[k - 1] + t * (a[k] - a[k - 1]),
          cheaperAbove: d1 < 0 ? ids[i] : ids[j],
        });
      }
    }
  }
  return out;
}
