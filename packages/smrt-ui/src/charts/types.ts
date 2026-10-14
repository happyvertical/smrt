import type { WidgetValueFormat } from './format.js';

/** Transport-neutral chart data. Money values use integer minor units. */
export interface ChartData {
  points: { label: string; value: number }[];
  format?: WidgetValueFormat;
  currency?: string;
  /** Explicit percentage change for a stat; otherwise derived from its last two points. */
  delta?: number | null;
}
