/**
 * Typography adoption (epic #3864, issue #3868): headings and utilities consume
 * the theme's type roles, the root paints the body face, and each preset's scale
 * keeps a coherent rhythm.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateThemeVariables } from '../css-generator.js';
import { availablePresets, getTheme } from '../registry.js';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const baseCss = read('src/themes/styles/base.css');
const provider = read('src/themes/ThemeProvider.svelte');

const HEADINGS: Record<string, string> = {
  h1: 'display-small',
  h2: 'headline-large',
  h3: 'headline-medium',
  h4: 'headline-small',
  h5: 'title-large',
  h6: 'title-medium',
};

const PROPS: Array<[string, string]> = [
  ['font-family', 'font-family'],
  ['font-size', 'size'],
  ['line-height', 'line-height'],
  ['font-weight', 'weight'],
  ['letter-spacing', 'tracking'],
];

describe('heading role mapping in base.css', () => {
  for (const [tag, role] of Object.entries(HEADINGS)) {
    it(`${tag} uses the ${role} role`, () => {
      const rule = new RegExp(
        `:is\\(body, \\.smrt-theme-root\\) ${tag}\\s*{([^}]*)}`,
      ).exec(baseCss);
      expect(rule, `${tag} rule`).not.toBeNull();
      const body = rule?.[1] ?? '';
      for (const [prop, suffix] of PROPS) {
        expect(body).toContain(
          `${prop}: var(${['--smrt', 'typography', role, suffix].join('-')})`,
        );
      }
      expect(body).toMatch(/margin-block:\s*var\(--smrt-spacing-\d\)/);
    });
  }

  it('wraps the typography block in a smrt layer', () => {
    expect(baseCss).toMatch(/@layer smrt\.structure\s*{/);
  });

  it('defines a utility class per role', () => {
    for (const k of ['display', 'headline', 'title', 'body', 'label']) {
      for (const s of ['large', 'medium', 'small']) {
        expect(baseCss).toContain(`.smrt-${k}-${s} {`);
      }
    }
  });

  it('turns on tabular figures for data surfaces and the theme feature settings', () => {
    expect(baseCss).toMatch(
      /font-feature-settings:\s*var\(--smrt-font-feature-settings\)/,
    );
    expect(baseCss).toMatch(
      /table,[^{]*\[data-smrt-component="DataTable"\][^{]*\[data-smrt-component="Badge"\][^{]*\.smrt-tabular\s*{[^}]*tabular-nums/s,
    );
  });
});

describe('body face painting', () => {
  it('base.css paints --smrt-font-family on body', () => {
    expect(baseCss).toMatch(
      /body\s*{[^}]*font-family:\s*var\(--smrt-font-family/s,
    );
  });

  it('ThemeProvider paints --smrt-font-family on its root', () => {
    expect(provider).toMatch(
      /\.smrt-theme-root\s*{[^}]*font-family:\s*var\(--smrt-font-family\)/s,
    );
  });
});

describe('per-preset type rhythm', () => {
  const em = (v: string) => Number.parseFloat(v);
  const displayRoles = [
    'displayLarge',
    'displayMedium',
    'displaySmall',
    'headlineLarge',
    'headlineMedium',
    'headlineSmall',
  ] as const;

  for (const preset of availablePresets) {
    describe(preset, () => {
      const theme = getTheme(preset);
      const t = theme.typography;

      it('uses one face across display and headline roles; body uses the body face', () => {
        const faces = new Set(displayRoles.map((r) => t[r].fontFamily));
        expect(faces.size).toBe(1);
        expect(t.bodyMedium.fontFamily).toBe('var(--smrt-font-family)');
      });

      it('tightens display tracking with size and keeps headlines at or below zero', () => {
        expect(em(t.displayLarge.tracking)).toBeLessThanOrEqual(
          em(t.displaySmall.tracking),
        );
        expect(em(t.displaySmall.tracking)).toBeLessThanOrEqual(0);
        expect(em(t.headlineLarge.tracking)).toBeLessThanOrEqual(0);
      });

      it('keeps body at 400 and emits the role variables', () => {
        expect(t.bodyMedium.weight).toBe('400');
        const vars = generateThemeVariables(theme, false);
        expect(vars['--smrt-typography-headline-large-font-family']).toBe(
          t.headlineLarge.fontFamily,
        );
      });
    });
  }

  it('smrt uses Space Grotesk for display and headline roles', () => {
    const t = getTheme('smrt').typography;
    expect(t.displayLarge.fontFamily).toContain('Space Grotesk');
    expect(t.headlineSmall.fontFamily).toContain('Space Grotesk');
  });

  it('labels weigh 500 except Day Shift, which documents bold labels', () => {
    for (const preset of availablePresets) {
      const w = getTheme(preset).typography.labelMedium.weight;
      expect(w).toBe(preset === 'happyvertical' ? '700' : '500');
    }
  });
});
