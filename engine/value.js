// Business value, ROI and break-even uplift. Currency-agnostic: pass amounts in any one currency.
//
// Headline figures are conservative: they use gross profit on the FIRST sale only.
// For repeat-purchase businesses a second, LTV-based figure is also given, using the
// value a new customer brings over 12 months.

const EPSILON = 1e-9;

/** Business profile thresholds, in USD-equivalent so they behave the same in every currency. */
export const PROFILE_THRESHOLDS = {
  lowTicketMaxUsd: 100,
  lowTicketMinConversations: 10_000,
  highTicketMinUsd: 10_000,
};

/** Percentage points with enough precision to never show a non-zero value as 0.00. */
export function formatPp(pp) {
  if (!Number.isFinite(pp)) return "—";
  if (pp === 0 || Math.abs(pp) >= 0.01) return pp.toFixed(2);
  return Number(pp.toPrecision(2)).toString();
}

export function classifyProfile(ticketUsd, conversationsPerMonth, t = PROFILE_THRESHOLDS) {
  if (ticketUsd >= t.highTicketMinUsd) return "high_ticket";
  if (ticketUsd < t.lowTicketMaxUsd && conversationsPerMonth > t.lowTicketMinConversations) return "low_ticket_high_volume";
  return "mid_ticket";
}

/**
 * Value of a workflow agent: hours of manual work saved, net of review time and errors.
 *   hours_saved  = tasks × success × minutes_per_task / 60
 *   review_hours = tasks × review_share × review_minutes / 60
 *   net_hours    = hours_saved − review_hours          (FTE = net_hours / hours_per_FTE)
 *   benefit      = net_hours × staff_hourly − tasks × error_rate × cost_per_error
 *   net          = benefit − option_monthly
 * @param p { tasksPerMonth, humanMinutesPerTask, successPct, reviewPct, reviewMinutes, errorPct,
 *            costPerError, staffHourly, fteHoursPerMonth, optionMonthly, oneTime }
 */
export function agentValue(p) {
  const tasks = p.tasksPerMonth;
  const at = (successPct) => {
    const hoursSaved = (tasks * (successPct / 100) * p.humanMinutesPerTask) / 60;
    const reviewHours = (tasks * (p.reviewPct / 100) * p.reviewMinutes) / 60;
    const netHours = hoursSaved - reviewHours;
    const errorCost = tasks * (p.errorPct / 100) * p.costPerError;
    const benefit = netHours * p.staffHourly - errorCost;
    const net = benefit - p.optionMonthly;
    return { successPct, hoursSaved, reviewHours, netHours, fte: netHours / p.fteHoursPerMonth, errorCost, benefit, net, roi: net / p.optionMonthly, paybackMonths: net > 0 ? p.oneTime / Math.max(EPSILON, net) : null };
  };
  const base = at(p.successPct);
  // Success rate at which benefit covers the AI cost (100% caps it: "not reachable").
  const perPointHours = (tasks * p.humanMinutesPerTask) / 60 / 100;
  const reviewCost = base.reviewHours * p.staffHourly;
  const breakevenSuccessPct = perPointHours * p.staffHourly > 0 ? (p.optionMonthly + reviewCost + base.errorCost) / (perPointHours * p.staffHourly) : Infinity;
  return {
    kind: "agent",
    ...base,
    aiCostPerTask: tasks > 0 ? p.optionMonthly / tasks : Infinity,
    valuePerTask: tasks > 0 ? base.benefit / tasks : 0,
    breakevenSuccessPct,
    sensitivity: [50, 70, 90].map(at),
    paybackAt: () => base.paybackMonths,
    roiAt: () => base.roi,
  };
}

/**
 * Gross profit a new customer brings over 12 months.
 * One-time: one sale. Repeat: gross profit × purchases per year. A directly entered value overrides both.
 */
export function customerValue12m({ ticket, marginPct, purchaseType = "one_time", purchasesPerYear = 1, ltv = null }) {
  if (ltv != null) return ltv;
  const grossProfit = ticket * (marginPct / 100);
  return purchaseType === "repeat" ? grossProfit * purchasesPerYear : grossProfit;
}

/**
 * All value metrics for one option.
 * @param p { ticket, marginPct, purchaseType, purchasesPerYear, ltv,
 *            conversationsPerMonth, conversionPct, humanCostPerConv, humanSharePct, deflectionPct, targetSharePct,
 *            optionMonthly, oneTime }
 */
export function valueMetrics(p) {
  const conv = p.conversionPct / 100;
  const grossProfitPerSale = p.ticket * (p.marginPct / 100);
  const value12m = customerValue12m(p);
  const valuePerConversation = grossProfitPerSale * conv;
  const salesPerMonth = p.conversationsPerMonth * conv;
  // Savings only on conversations that would reach a human today (default: all of them).
  const humanShare = (p.humanSharePct ?? 100) / 100;
  const supportSavings = p.conversationsPerMonth * humanShare * (p.deflectionPct / 100) * p.humanCostPerConv;
  const breakevenExtraSales = grossProfitPerSale > 0 ? p.optionMonthly / grossProfitPerSale : Infinity;
  const ltvBreakevenCustomers = value12m > 0 ? p.optionMonthly / value12m : Infinity;
  const aiCostPerSale = salesPerMonth > 0 ? p.optionMonthly / salesPerMonth : Infinity;

  const netBenefitAt = (upliftPp) => p.conversationsPerMonth * (upliftPp / 100) * grossProfitPerSale + supportSavings - p.optionMonthly;
  const roiAt = (upliftPp) => netBenefitAt(upliftPp) / p.optionMonthly;
  const paybackAt = (upliftPp) => {
    const net = netBenefitAt(upliftPp);
    return net <= 0 ? null : p.oneTime / Math.max(EPSILON, net); // null = "never"
  };

  return {
    grossProfitPerSale,
    customerValue12m: value12m,
    hasLtvLine: value12m !== grossProfitPerSale,
    valuePerConversation,
    acceptableAiCostPerConversation: valuePerConversation * (p.targetSharePct / 100),
    aiCostPerConversation: p.conversationsPerMonth > 0 ? p.optionMonthly / p.conversationsPerMonth : Infinity,
    salesPerMonth,
    aiCostPerSale,
    aiCostPctOfTicket: p.ticket > 0 ? (aiCostPerSale / p.ticket) * 100 : Infinity,
    breakevenExtraSales,
    salesNeeded: Number.isFinite(breakevenExtraSales) ? Math.ceil(breakevenExtraSales - EPSILON) : Infinity,
    breakevenConversionUpliftPp: p.conversationsPerMonth > 0 ? (breakevenExtraSales / p.conversationsPerMonth) * 100 : Infinity,
    ltvBreakevenCustomers,
    ltvCustomersNeeded: Number.isFinite(ltvBreakevenCustomers) ? Math.ceil(ltvBreakevenCustomers - EPSILON) : Infinity,
    supportSavings,
    sensitivity: [0, 0.5, 1, 2, 5].map((u) => ({ upliftPp: u, roi: roiAt(u), paybackMonths: paybackAt(u) })),
    roiAt,
    paybackAt,
  };
}

/**
 * Value of one workload at a given monthly AI cost: time saved for workflow agents,
 * sales and support savings for conversational use cases.
 * @param inputs  that workload's full inputs     @param vol  volume(inputs, 0)
 */
export function valueForInputs(inputs, vol, monthly, oneTime, { agent, internal, deflectionPct = inputs.deflectionPct } = {}) {
  if (internal) {
    // Each request saves a few minutes of staff time; no review or error model.
    const at = (minutes) =>
      agentValue({ tasksPerMonth: vol.requestsPerMonth, humanMinutesPerTask: minutes, successPct: 100, reviewPct: 0, reviewMinutes: 0, errorPct: 0, costPerError: 0, staffHourly: inputs.staffHourlyUsd, fteHoursPerMonth: inputs.fteHoursPerMonth, optionMonthly: monthly, oneTime });
    const v = at(inputs.minutesSavedPerRequest);
    const perMinuteValue = (vol.requestsPerMonth / 60) * inputs.staffHourlyUsd;
    return {
      ...v,
      internal: true,
      breakevenMinutesPerRequest: perMinuteValue > 0 ? monthly / perMinuteValue : Infinity,
      sensitivity: [0.5, 1, 2].map((f) => ({ ...at(inputs.minutesSavedPerRequest * f), minutes: inputs.minutesSavedPerRequest * f })),
    };
  }
  if (agent) {
    return agentValue({
      tasksPerMonth: vol.tasks,
      humanMinutesPerTask: inputs.humanMinutesPerTask,
      successPct: inputs.successPct,
      reviewPct: inputs.reviewPct,
      reviewMinutes: inputs.reviewMinutes,
      errorPct: inputs.errorPct,
      costPerError: inputs.costPerErrorUsd,
      staffHourly: inputs.staffHourlyUsd,
      fteHoursPerMonth: inputs.fteHoursPerMonth,
      optionMonthly: monthly,
      oneTime,
    });
  }
  return valueMetrics({
    ticket: inputs.ticketUsd,
    marginPct: inputs.marginPct,
    purchaseType: inputs.purchaseType,
    purchasesPerYear: inputs.purchasesPerYear,
    ltv: inputs.ltvUsd,
    conversationsPerMonth: vol.conversationsPerMonth,
    conversionPct: inputs.conversionPct,
    humanCostPerConv: inputs.humanCostPerConvUsd,
    humanSharePct: inputs.humanSharePct,
    deflectionPct,
    targetSharePct: inputs.targetSharePct,
    optionMonthly: monthly,
    oneTime,
  });
}
