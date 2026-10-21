// Indirect tax (VAT, GST, HST, PST, sales tax) on external spend.
// Vendor prices exclude tax. A tax component is a real cost when it cannot be reclaimed:
// either it is never reclaimable (US sales tax, Canadian PST) or the business is not
// registered / is VAT-exempt. Labour is assumed in-house, so it carries no tax.

/** The tax variant chosen for the inputs' region (falls back to the region default). */
export function taxVariant(inputs, taxes) {
  const region = taxes?.regions?.[inputs.region];
  if (!region) return { region: null, variant: null };
  const variant = region.variants.find((v) => v.id === inputs.taxVariant) || region.variants.find((v) => v.id === region.default_variant);
  return { region, variant };
}

/**
 * @returns { name, components: [{ name, ratePct, recoverable, counted }], nonRecoverablePct, totalPct, notes }
 * `counted` = this component is added to cost.
 */
export function taxProfile(inputs, taxes) {
  const { region, variant } = taxVariant(inputs, taxes);
  if (!variant) return { name: "Tax", label: "No tax data", components: [], nonRecoverablePct: 0, totalPct: 0, notes: [] };
  const components = variant.components.map((c) => {
    const ratePct = c.rate_pct ?? inputs.customTaxPct ?? 0;
    const counted = !c.recoverable || !inputs.taxRegistered;
    return { name: c.name, ratePct, recoverable: c.recoverable, counted, isSample: c.is_sample, sourceUrl: c.source_url, lastVerified: c.last_verified };
  });
  return {
    name: region.tax_name,
    label: variant.label,
    variantId: variant.id,
    components,
    nonRecoverablePct: components.filter((c) => c.counted).reduce((s, c) => s + c.ratePct, 0),
    totalPct: components.reduce((s, c) => s + c.ratePct, 0),
    notes: region.notes || [],
  };
}

/** Adds a non-reclaimable tax line on all non-labour lines of one option's monthly result. */
export function applyTax(result, profile) {
  if (!profile || profile.nonRecoverablePct <= 0 || !Number.isFinite(result.total)) return result;
  const taxable = result.lines.filter((l) => !l.labour).reduce((s, l) => s + l.usd, 0);
  const names = profile.components.filter((c) => c.counted).map((c) => c.name).join(" + ");
  const line = { label: `Tax not reclaimable (${names})`, usd: (taxable * profile.nonRecoverablePct) / 100, tax: true, taxBase: taxable, taxPct: profile.nonRecoverablePct };
  return { ...result, lines: [...result.lines, line], total: result.total + line.usd, taxMonthly: line.usd };
}
