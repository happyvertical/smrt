/**
 * Control-boundary contrast floor, every preset (#2322).
 *
 * WCAG 2.2 SC 1.4.11 requires the visual boundary that identifies a UI
 * component to clear 3:1 against its adjacent background. The form primitives
 * used to draw their resting border with `outline-variant` — the divider role,
 * which measures 1.2–1.7:1 in every preset — so an input's edge was effectively
 * invisible. They now consume `outline`, and this test pins the other half of
 * that contract: `outline` must actually be a boundary-strength value in every
 * preset and scheme, on every surface a control can sit on.
 *
 * `outlineVariant` is deliberately NOT held to this floor. It is the quiet
 * hairline for dividers, panel edges, and readout rows; raising it would erase
 * the distinction the two tokens exist to draw.
 */

import { describe, expect, it } from 'vitest';
import { themes } from '../registry.js';
import type { ColorPalette } from '../types.js';

/** Every surface role a control can be placed on. */
const SURFACES = [
  'surface',
  'surfaceVariant',
  'surfaceContainer',
  'surfaceContainerLow',
  'surfaceContainerHigh',
  'surfaceContainerHighest',
  'surfaceContainerLowest',
  'surfaceDim',
  'surfaceBright',
  'background',
] as const satisfies readonly (keyof ColorPalette)[];

type Rgb = [number, number, number];

/**
 * Parse `#rrggbb` or `rgba(r, g, b, a)` into a straight-alpha colour.
 *
 * The glass preset expresses its surfaces and outlines as `rgba(...)`, so a
 * hex-only parser silently skips exactly the preset whose translucency makes
 * contrast hardest to reason about — which is how glass sat at 1.42:1 unnoticed.
 */
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

/** Composite `value` over an opaque backdrop, resolving any alpha. */
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

describe('control boundaries clear the 3:1 non-text floor (#2322)', () => {
  for (const theme of Object.values(themes)) {
    for (const scheme of ['light', 'dark'] as const) {
      const palette = theme[scheme];

      it(`${theme.id} ${scheme}: outline is boundary-strength on every surface`, () => {
        // Translucent surfaces resolve against the scheme's own background,
        // which is the only backdrop the theme can promise.
        const page = flatten(palette.background, [255, 255, 255]);
        expect(
          page,
          `${theme.id} ${scheme} background must be parseable`,
        ).not.toBeNull();

        const failures: string[] = [];
        for (const surfaceName of SURFACES) {
          // Assert each parse BEFORE it is used as the next one's backdrop.
          // Folding these together would let an unparseable surface reach
          // `flatten` as a null backdrop, and the test would die on a
          // TypeError instead of naming the token that could not be read.
          const surface = flatten(palette[surfaceName] as string, page as Rgb);
          expect(
            surface,
            `${theme.id} ${scheme} ${surfaceName} must be parseable`,
          ).not.toBeNull();

          const outline = flatten(palette.outline, surface as Rgb);
          expect(
            outline,
            `${theme.id} ${scheme} outline must be parseable`,
          ).not.toBeNull();

          const ratio = contrast(outline as Rgb, surface as Rgb);
          if (ratio < 3) failures.push(`${surfaceName} ${ratio.toFixed(2)}:1`);
        }

        expect(failures, `${theme.id} ${scheme} outline below 3:1`).toEqual([]);
      });
    }
  }

  it('keeps outline and outlineVariant as distinct roles', () => {
    // If a preset ever "fixes" its bezel by setting it equal to the boundary,
    // dividers become as loud as control edges and the two-token system
    // collapses. The hairline is allowed to be quiet — it just may not BE the
    // boundary token.
    for (const theme of Object.values(themes)) {
      for (const scheme of ['light', 'dark'] as const) {
        expect(
          theme[scheme].outlineVariant,
          `${theme.id} ${scheme} outlineVariant must stay distinct from outline`,
        ).not.toBe(theme[scheme].outline);
      }
    }
  });
});
