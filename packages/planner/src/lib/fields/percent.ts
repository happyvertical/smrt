/**
 * Rates such as tax and discount are stored as fractions (0.05 is 5%) but
 * typed as percentages (5): people think in percent, the model keeps fractions.
 */

/** A stored fraction as the percentage a person types: `0.0825` -> `8.25`. */
export function fractionToPercent(fraction: unknown): number | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null;
  return Number((fraction * 100).toFixed(4));
}

/** A typed percentage as the stored fraction: `8.25` -> `0.0825`. */
export function percentToFraction(percent: number | null): number | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  return Number((percent / 100).toFixed(6));
}
