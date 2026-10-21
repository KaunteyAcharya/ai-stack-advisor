// Currency conversion and number formatting. All amounts are stored in USD and converted for display.

export const FORMAT_LOCALES = {
  indian: "en-IN",
  international: "en-US",
  european: "de-DE",
  swiss: "de-CH",
};

/** USD → target currency using fx.json-style rates (units of X per 1 USD). */
export function fromUsd(amountUsd, currency, fx) {
  const rate = fx.rates[currency];
  if (!rate) throw new Error(`No rate for ${currency}`);
  return amountUsd * rate;
}

export function toUsd(amount, currency, fx) {
  const rate = fx.rates[currency];
  if (!rate) throw new Error(`No rate for ${currency}`);
  return amount / rate;
}

/** Locale to use: explicit format choice, else the currency's own locale. */
export function localeFor(currency, numberFormat = "auto", currencies = {}) {
  if (numberFormat && numberFormat !== "auto" && FORMAT_LOCALES[numberFormat]) return FORMAT_LOCALES[numberFormat];
  return currencies[currency]?.locale || "en-US";
}

/** Full currency format, e.g. ₹65,00,000 or 1.234.567,89 €. */
export function formatMoney(amount, currency, locale, { decimals } = {}) {
  const abs = Math.abs(amount);
  const d = decimals ?? (abs >= 100 ? 0 : abs >= 1 ? 2 : 4);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  }).format(amount);
}

/** Lakh / crore wording for INR, e.g. "₹65 lakh", "₹1.4 crore". Returns null below 1 lakh. */
export function formatIndianWords(amount) {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  const trim = (x) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(x.toPrecision(3)));
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)} crore`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)} lakh`;
  return null;
}

/** Compact format: lakh/crore for INR, Intl compact (k, M, B) otherwise. */
export function formatCompact(amount, currency, locale) {
  if (currency === "INR") return formatIndianWords(amount) ?? formatMoney(amount, currency, locale, { decimals: 0 });
  if (Math.abs(amount) < 1000) return formatMoney(amount, currency, locale, { decimals: 0 });
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(amount);
}

export function formatNumber(n, locale, maxDecimals = 0) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: maxDecimals }).format(n);
}

/** Convenience: build a formatter bound to a display currency. */
export function makeFormatter({ currency, numberFormat = "auto", fx, currencies }) {
  const locale = localeFor(currency, numberFormat, currencies);
  return {
    currency,
    locale,
    rateFromUsd: fx.rates[currency],
    money: (usd, opts) => formatMoney(fromUsd(usd, currency, fx), currency, locale, opts),
    rate: (usd) => formatRate(fromUsd(usd, currency, fx), currency, locale),
    compact: (usd) => formatCompact(fromUsd(usd, currency, fx), currency, locale),
    number: (n, d) => formatNumber(n, locale, d),
  };
}

/**
 * Rounds a converted preset amount to a figure a person would type:
 * INR ≥ 1 lakh → nearest lakh; ≥ 10,000 → nearest 1,000; ≥ 1,000 → nearest 100; ≥ 100 → nearest 10;
 * ≥ 10 → whole number; below that, one decimal.
 */
export function roundSensible(amount, currency) {
  const abs = Math.abs(amount);
  let step;
  if (currency === "INR" && abs >= 1e5) step = 1e5;
  else if (abs >= 1e4) step = 1000;
  else if (abs >= 1000) step = 100;
  else if (abs >= 100) step = 10;
  else if (abs >= 10) step = 1;
  else step = 0.1;
  const r = Math.round(amount / step) * step;
  return step < 1 ? Number(r.toFixed(1)) : r;
}

/** Unit rates such as a price per request: three significant figures below 1, e.g. ₹0.138 or 0,00129 €. */
export function formatRate(amount, currency, locale) {
  if (Math.abs(amount) >= 1) return formatMoney(amount, currency, locale, { decimals: 2 });
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumSignificantDigits: 3 }).format(amount);
}
