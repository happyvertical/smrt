/**
 * Primary-as-text contrast floor, every preset (#4567).
 *
 * Ghost `Button`s, links and other quiet controls draw their text in
 * `primary` on whatever surface they sit on. WCAG 2.2 SC 1.4.3 asks 4.5:1 for
 * normal-size text, and Glass light shipped `#007aff`, which is 3.6:1 on its
 * background — "Mark read" in a NotificationBell panel was faint enough for
 * QA to measure it. This pins `primary` to the AA floor on every surface a
 * control can be read on, in every preset and scheme, and `onPrimary` to the
 * same floor on `primary` itself (filled buttons).
 *
 * `surfaceDim` is not a reading surface (it is the dimmed-page role under
 * overlays), so it is deliberately left out.
 *
 * Three scheme palettes do not reach the floor today and keep their brand
 * primary (lifting it recolours every filled and ghost control in the preset,
 * which is a preset-design decision with its own visual baselines: #4575).
 * They are pinned at what they reach now so they cannot slide further;
 * delete the entry when a preset is brought to AA.
 */

import { describe, expect, it } from 'vitest';
import { themes } from '../registry.js';
import type { ColorPalette } from '../types.js';

const TEXT_SURFACES = [
  'surface',
  'surfaceVariant',
  'surfaceContainer',
  'surfaceContainerLow',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'surfaceContainerLowest',
  'surfaceBright',
  'background',
] as const satisfies readonly (keyof ColorPalette)[];

const AA_TEXT = 4.5;

/** Worst primary-on-surface ratio a palette reaches today (rounded down), where below AA. */
const KNOWN_BELOW_AA: Record<string, number> = {
  'glass dark': 2.7,
  'studio light': 3.2,
  'smrt light': 2.9,
};
/** `onPrimary` on `primary`, where below AA today. */
const KNOWN_ON_PRIMARY_BELOW_AA: Record<string, number> = {
  'smrt light': 3.5,
};

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = value
    .trim()
    .match(
      /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i,
    );
  if (rgba) {
    return {
      rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return null;
}

function flatten(value: string, backdrop: Rgb): Rgb | null {
  const parsed = parseColor(value);
  if (!parsed) return null;
  const { rgb, alpha } = parsed;
  return rgb.map((c, i) =>
    Math.round(c * alpha + backdrop[i] * (1 - alpha)),
  ) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
  const [rr, gg, bb] = [r, g, b].map((n) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  );
  return (hi + 0.05) / (lo + 0.05);
}

describe('primary clears the 4.5:1 text floor (#4567)', () => {
  for (const theme of Object.values(themes)) {
    for (const scheme of ['light', 'dark'] as const) {
      const palette = theme[scheme];

      const key = `${theme.id} ${scheme}`;
      const floor = KNOWN_BELOW_AA[key] ?? AA_TEXT;
      const onPrimaryFloor = KNOWN_ON_PRIMARY_BELOW_AA[key] ?? AA_TEXT;

      it(`${key}: primary reads as text on every surface (floor ${floor}:1)`, () => {
        const page = flatten(palette.background, [255, 255, 255]);
        expect(
          page,
          `${theme.id} ${scheme} background must be parseable`,
        ).not.toBeNull();
        const primary = flatten(palette.primary, page as Rgb);
        expect(
          primary,
          `${theme.id} ${scheme} primary must be parseable`,
        ).not.toBeNull();

        const failures: string[] = [];
        for (const surfaceName of TEXT_SURFACES) {
          const surface = flatten(palette[surfaceName] as string, page as Rgb);
          expect(
            surface,
            `${theme.id} ${scheme} ${surfaceName} must be parseable`,
          ).not.toBeNull();
          const ratio = contrast(primary as Rgb, surface as Rgb);
          if (ratio < floor)
            failures.push(`${surfaceName} ${ratio.toFixed(2)}:1`);
        }
        expect(failures, `${key} primary below ${floor}:1`).toEqual([]);
      });

      it(`${key}: onPrimary reads as text on primary (floor ${onPrimaryFloor}:1)`, () => {
        const page = flatten(palette.background, [255, 255, 255]) as Rgb;
        const primary = flatten(palette.primary, page) as Rgb;
        const onPrimary = flatten(palette.onPrimary, primary);
        expect(onPrimary).not.toBeNull();
        expect(contrast(onPrimary as Rgb, primary)).toBeGreaterThanOrEqual(
          onPrimaryFloor,
        );
      });
    }
  }
});
