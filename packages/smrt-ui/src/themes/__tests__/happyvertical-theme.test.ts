/**
 * HappyVertical "Day Shift" preset contract (#2318).
 *
 * The brand identity ships as a preset, so its guarantees have to be executable
 * rather than described: every text/surface pairing clears WCAG AA in BOTH
 * hand-authored schemes, structure and the amber focus ring clear 3:1 non-text,
 * green is never a text color, and the static stylesheet is the generator's
 * output verbatim (#1586 lockstep — checked on the whole block, not just
 * elevation).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateThemeCSS, generateThemeVariables } from '../css-generator.js';
import { happyverticalTheme } from '../happyvertical/index.js';
import type { ColorPalette } from '../types.js';

// Resolved from process.cwd() (NOT import.meta.url): the smrt-vitest plugin runs
// each package's suite with cwd === the package root.
const staticCss = readFileSync(
  join(process.cwd(), 'src/themes/styles/happyvertical.css'),
  'utf8',
);
const themeProviderSource = readFileSync(
  join(process.cwd(), 'src/themes/ThemeProvider.svelte'),
  'utf8',
);

/** Relative luminance per WCAG 2.1. */
function luminance(hex: string): number {
  const value = Number.parseInt(hex.replace('#', ''), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const [r, g, b] = channels.map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque hex colors. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** on<Role> ↔ <Role> pairs that carry normal text. */
const ON_PAIRS: [keyof ColorPalette, keyof ColorPalette][] = [
  ['onPrimary', 'primary'],
  ['onPrimaryContainer', 'primaryContainer'],
  ['onSecondary', 'secondary'],
  ['onSecondaryContainer', 'secondaryContainer'],
  ['onTertiary', 'tertiary'],
  ['onTertiaryContainer', 'tertiaryContainer'],
  ['onError', 'error'],
  ['onErrorContainer', 'errorContainer'],
  ['onWarning', 'warning'],
  ['onWarningContainer', 'warningContainer'],
  ['onSuccess', 'success'],
  ['onSuccessContainer', 'successContainer'],
  ['onSurface', 'surface'],
  ['onSurfaceVariant', 'surfaceVariant'],
  ['onBackground', 'background'],
  ['inverseOnSurface', 'inverseSurface'],
];

const SURFACES: (keyof ColorPalette)[] = [
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
];

const INK: (keyof ColorPalette)[] = ['onSurface', 'onSurfaceVariant'];

/**
 * Accent roles that may be rendered as text on a surface. `success` is
 * deliberately absent: the brand rule is that green is a lamp, marker, or fill
 * and never a text color, so it is only held to the 3:1 marker floor below.
 */
const ACCENT_TEXT: (keyof ColorPalette)[] = [
  'primary',
  'error',
  'warning',
  'tertiary',
  'secondary',
];

const SCHEMES = [
  ['light', happyverticalTheme.light],
  ['dark', happyverticalTheme.dark],
] as const;

describe('happyvertical preset — WCAG AA (#2318)', () => {
  for (const [scheme, palette] of SCHEMES) {
    it(`${scheme}: every on<Role> pairing clears 4.5:1`, () => {
      for (const [on, base] of ON_PAIRS) {
        expect(
          contrast(palette[on] as string, palette[base] as string),
          `${scheme} ${on} on ${base}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${scheme}: ink clears 4.5:1 on every surface slot`, () => {
      for (const ink of INK) {
        for (const surface of SURFACES) {
          expect(
            contrast(palette[ink] as string, palette[surface] as string),
            `${scheme} ${ink} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${scheme}: accent text clears 4.5:1 on every surface slot`, () => {
      for (const accent of ACCENT_TEXT) {
        for (const surface of SURFACES) {
          expect(
            contrast(palette[accent] as string, palette[surface] as string),
            `${scheme} ${accent} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${scheme}: outline, focus ring, and status lamp clear 3:1 non-text`, () => {
      for (const surface of SURFACES) {
        for (const structural of ['outline', 'primary', 'success'] as const) {
          expect(
            contrast(palette[structural] as string, palette[surface] as string),
            `${scheme} ${structural} on ${surface}`,
          ).toBeGreaterThanOrEqual(3);
        }
      }
    });
  }
});

describe('happyvertical preset — brand invariants (#2318)', () => {
  it('hand-authors both schemes rather than deriving dark from light', () => {
    // A generated dark scheme mirrors the light hues; Day Shift's night palette
    // is authored independently and shares no surface value with the day one.
    for (const surface of SURFACES) {
      expect(happyverticalTheme.dark[surface]).not.toBe(
        happyverticalTheme.light[surface],
      );
    }
  });

  it('keeps the dark scheme blue-graphite rather than neutral near-black', () => {
    // Blue-graphite means the blue channel leads the red one on every dark
    // surface; a collapse to neutral/near-black would flatten that difference.
    for (const surface of SURFACES) {
      const hex = happyverticalTheme.dark[surface] as string;
      const value = Number.parseInt(hex.replace('#', ''), 16);
      const red = (value >> 16) & 255;
      const blue = value & 255;
      expect(
        blue,
        `dark ${surface} (${hex}) should keep a blue cast`,
      ).toBeGreaterThan(red);
    }
  });

  it('carries both accent hues into dark — amber and green', () => {
    expect(happyverticalTheme.dark.primary).toBe('#ffb454');
    expect(happyverticalTheme.dark.success).toBe('#53c989');
    expect(happyverticalTheme.dark.primary).not.toBe(
      happyverticalTheme.dark.success,
    );
  });

  it('is not undermined by a component painting text with the success token', () => {
    // "Green is never text" is only a real guarantee if nothing renders it as
    // one: light `#1e7a4b` measures 4.44:1 on the enamel ground, just under AA.
    // Omitting `success` from ACCENT_TEXT above states the rule; this scan
    // enforces it for the components this package owns.
    const svelteFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.svelte')) svelteFiles.push(full);
      }
    };
    walk(join(process.cwd(), 'src'));

    // `color:` exactly — not `border-color:`, `background-color:`, or a custom
    // property like `--alert-color:` that later paints a marker or fill.
    const textPaint = /(?<![-\w])color\s*:\s*var\(\s*--smrt-color-success/;
    const offenders = svelteFiles.filter((file) =>
      textPaint.test(readFileSync(file, 'utf8')),
    );

    expect(
      offenders.map((file) => file.replace(process.cwd(), '')),
      'success is a lamp/marker/fill, never a text color',
    ).toEqual([]);
  });

  it('uses one calm easing for every motion token', () => {
    const curves = new Set(Object.values(happyverticalTheme.easing));
    expect(curves.size).toBe(1);
  });

  it('sets ~120ms as the standard state-transition duration', () => {
    expect(happyverticalTheme.duration.normal).toBe('120ms');
  });

  it('names the B612 Mono stack as the preset monospace family', () => {
    const light = generateThemeVariables(happyverticalTheme, false);
    const dark = generateThemeVariables(happyverticalTheme, true);
    expect(light['--smrt-font-family-mono']).toContain('B612 Mono');
    expect(dark['--smrt-font-family-mono']).toContain('B612 Mono');
  });

  it('defines a 2px amber focus outline with offset on BOTH delivery paths', () => {
    // The preset ships two ways — a static stylesheet import and
    // <ThemeProvider preset="happyvertical">. A focus rule that exists in only
    // one of them means half the consumers silently lose the brand indicator.
    const sources: [string, RegExp][] = [
      [staticCss, /\[data-theme="happyvertical"\] :focus-visible \{([^}]*)\}/],
      [
        themeProviderSource,
        /:global\(\[data-theme='happyvertical'\] :focus-visible\) \{([^}]*)\}/,
      ],
    ];
    for (const [source, pattern] of sources) {
      const focusBlock = source.match(pattern);
      expect(focusBlock, 'focus-visible rule should exist').not.toBeNull();
      expect(focusBlock?.[1]).toContain(
        'outline: 2px solid var(--smrt-color-primary)',
      );
      expect(focusBlock?.[1]).toMatch(/outline-offset:\s*2px/);
    }
  });
});

describe('happyvertical static CSS lockstep (#1586)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    it(`${scheme} block matches generateThemeCSS output verbatim`, () => {
      const generated = generateThemeCSS(happyverticalTheme, scheme === 'dark');
      expect(staticCss).toContain(generated);
    });
  }
});
