import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatIndianWords, formatCompact, localeFor, makeFormatter } from "../assets/format.js";
import { TEST_FX } from "./fixtures.js";

test("scenario 7: INR grouping and lakh/crore words", () => {
  assert.equal(formatMoney(6_500_000, "INR", "en-IN"), "₹65,00,000");
  assert.equal(formatIndianWords(6_500_000), "₹65 lakh");
  assert.equal(formatIndianWords(14_000_000), "₹1.4 crore");
  assert.equal(formatIndianWords(50_000), null);
  assert.equal(formatCompact(14_000_000, "INR", "en-IN"), "₹1.4 crore");
});

// Exact spacing varies by ICU version, so compare against Intl's own output and check separators.
const cases = [
  ["USD", "en-US", ",", "."],
  ["GBP", "en-GB", ",", "."],
  ["CAD", "en-CA", ",", "."],
  ["AUD", "en-AU", ",", "."],
  ["AED", "en-AE", ",", "."],
  ["CHF", "de-CH", "’", "."], // some ICU versions use an ASCII apostrophe
  ["EUR", "de-DE", ".", ","],
  ["EUR", "en-IE", ",", "."],
];

for (const [cur, locale, group, dec] of cases) {
  test(`scenario 7: 1234567.89 in ${cur} (${locale})`, () => {
    const s = formatMoney(1234567.89, cur, locale, { decimals: 2 });
    const expected = new Intl.NumberFormat(locale, { style: "currency", currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234567.89);
    assert.equal(s, expected);
    assert.ok([group, "'"].some((g) => s.includes(`1${g}234${g}567${dec}89`)), `${s} has grouping '${group}' and decimal '${dec}'`);
  });
}

test("symbol placement: € after the number in de-DE, before in en-IE", () => {
  assert.ok(formatMoney(1234567.89, "EUR", "de-DE", { decimals: 2 }).trim().endsWith("€"));
  assert.ok(formatMoney(1234567.89, "EUR", "en-IE", { decimals: 2 }).startsWith("€"));
});

test("compact notation for non-INR", () => {
  assert.equal(formatCompact(1_200_000, "EUR", "en-IE"), "€1.2M");
});

test("number format override selects locale", () => {
  assert.equal(localeFor("USD", "indian"), "en-IN");
  assert.equal(localeFor("EUR", "auto", { EUR: { locale: "de-DE" } }), "de-DE");
});

test("formatter converts USD before formatting", () => {
  const f = makeFormatter({ currency: "INR", fx: TEST_FX, currencies: { INR: { locale: "en-IN" } } });
  assert.equal(f.money(1000), "₹80,000");
});

test("preset amounts round to sensible figures", async () => {
  const { roundSensible } = await import("../assets/format.js");
  assert.equal(roundSensible(6_234_567, "INR"), 6_200_000);
  assert.equal(roundSensible(64_321, "EUR"), 64_000);
  assert.equal(roundSensible(1_234, "USD"), 1_200);
  assert.equal(roundSensible(21.4, "EUR"), 21);
  assert.equal(roundSensible(0.56, "GBP"), 0.6);
});

test("unit rates keep three significant figures", async () => {
  const { formatRate } = await import("../assets/format.js");
  assert.equal(formatRate(0.00145, "USD", "en-US"), "$0.00145");
  assert.equal(formatRate(0.138, "INR", "en-IN"), "₹0.138");
  assert.equal(formatRate(12.5, "USD", "en-US"), "$12.50");
});

test("compact amounts below 1,000 are whole numbers", () => {
  assert.equal(formatCompact(495.7, "USD", "en-US"), "$496");
});
