/**
 * Premium-baseline token families (epic #3864, issue #3865): every preset and
 * `createTheme()` output defines every new token in both schemes.
 */
import { describe, expect, it } from 'vitest';
import { createTheme, createThemeFromColor } from '../create-theme.js';
import { generateThemeVariables } from '../css-generator.js';
import { availablePresets, getTheme } from '../registry.js';

const BASELINE_TOKENS = [
  ...['ground', 'panel', 'control', 'raised', 'sunken', 'overlay'].map(
    (k) => `--smrt-surface-${k}`,
  ),
  '--smrt-hairline-color',
  '--smrt-hairline-strong-color',
  '--smrt-hairline',
  '--smrt-hairline-strong',
  '--smrt-inset-highlight',
  ...['hover', 'pressed', 'selected', 'focus', 'dragged', 'disabled'].map(
    (k) => `--smrt-state-${k}`,
  ),
  '--smrt-shadow-color',
  ...[
    'radius',
    'radius-small',
    'height',
    'height-small',
    'weight',
    'border',
  ].map((k) => `--smrt-control-${k}`),
  '--smrt-focus-ring-color',
  '--smrt-focus-ring-width',
  '--smrt-focus-ring-offset',
  '--smrt-accent-color',
  '--smrt-selection-background',
  '--smrt-selection-color',
  '--smrt-caret-color',
  '--smrt-scrollbar-thumb',
  '--smrt-scrollbar-track',
  '--smrt-glass-blur',
  '--smrt-glass-saturation',
  '--smrt-glass-surface',
  '--smrt-glass-surface-strong',
  '--smrt-glass-border',
  '--smrt-duration-scheme',
  '--smrt-font-feature-settings',
];

describe('premium baseline tokens', () => {
  for (const preset of availablePresets) {
    for (const isDark of [false, true]) {
      it(`${preset} ${isDark ? 'dark' : 'light'} defines every baseline token`, () => {
        const vars = generateThemeVariables(getTheme(preset), isDark);
        for (const token of BASELINE_TOKENS) {
          expect(vars[token], token).toBeTruthy();
        }
        expect(vars['--smrt-hairline']).toBe(
          '1px solid var(--smrt-hairline-color)',
        );
        expect(vars['--smrt-shadow-color']).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
      });
    }
  }

  it('removes the superseded glass opacity tokens', () => {
    const vars = generateThemeVariables(getTheme('glass'), false);
    expect(vars['--smrt-glass-border-opacity']).toBeUndefined();
    expect(vars['--smrt-glass-background-opacity']).toBeUndefined();
  });

  it('non-glass presets are opaque; glass blurs', () => {
    expect(
      generateThemeVariables(getTheme('material'), false)['--smrt-glass-blur'],
    ).toBe('0px');
    expect(
      generateThemeVariables(getTheme('glass'), true)['--smrt-glass-blur'],
    ).toBe('20px');
  });

  it('createTheme derives the families from the palette', () => {
    const theme = createTheme({
      id: 'derived',
      name: 'Derived',
      light: { primary: '#ff6b35', background: '#fafafa' },
    });
    for (const isDark of [false, true]) {
      const vars = generateThemeVariables(theme, isDark);
      for (const token of BASELINE_TOKENS)
        expect(vars[token], token).toBeTruthy();
    }
    const light = generateThemeVariables(theme, false);
    const dark = generateThemeVariables(theme, true);
    expect(light['--smrt-hairline-color']).toBe(
      'color-mix(in srgb, var(--smrt-color-on-surface) 12%, transparent)',
    );
    expect(light['--smrt-hairline-strong-color']).toContain('20%');
    expect(light['--smrt-state-hover']).toBe('0.08');
    expect(light['--smrt-state-disabled']).toBe('0.38');
    expect(light['--smrt-control-radius']).toBe('var(--smrt-radius-md)');
    expect(light['--smrt-control-height']).toBe('2.75rem');
    expect(light['--smrt-control-border']).toBe('var(--smrt-hairline-strong)');
    expect(light['--smrt-inset-highlight']).toBe('none');
    expect(dark['--smrt-inset-highlight']).toContain('inset 0 1px 0');
    expect(light['--smrt-surface-ground']).toBe('#fafafa');
    expect(light['--smrt-glass-blur']).toBe('0px');
    expect(light['--smrt-accent-color']).toBe('var(--smrt-color-primary)');
  });

  it('createTheme overrides win over derived defaults', () => {
    const theme = createThemeFromColor('#0b57d0', 'ovr', 'Ovr', {
      states: { hover: '0.1' },
      controls: { height: '3rem' },
      fontFeatureSettings: '"tnum" 1',
    });
    const vars = generateThemeVariables(theme, false);
    expect(vars['--smrt-state-hover']).toBe('0.1');
    expect(vars['--smrt-state-pressed']).toBe('0.12');
    expect(vars['--smrt-control-height']).toBe('3rem');
    expect(vars['--smrt-control-height-small']).toBe('2.25rem');
    expect(vars['--smrt-font-feature-settings']).toBe('"tnum" 1');
  });

  it('a theme without baseline sections still gets every token', () => {
    const {
      surfaces,
      hairlines,
      states,
      shadowColor,
      controls,
      focus,
      native,
      ...bare
    } = getTheme('material');
    void [surfaces, hairlines, states, shadowColor, controls, focus, native];
    const vars = generateThemeVariables(bare, true);
    for (const token of BASELINE_TOKENS)
      expect(vars[token], token).toBeTruthy();
  });

  describe('preset re-tuning (#3866)', () => {
    /** WCAG relative luminance of a `#rrggbb` token value. */
    const luminance = (hex: string): number => {
      expect(hex, 'ladder rungs of these presets are opaque hex').toMatch(
        /^#[0-9a-f]{6}$/i,
      );
      const n = Number.parseInt(hex.slice(1), 16);
      const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    };
    const rung = (preset: string, isDark: boolean, name: string): string =>
      generateThemeVariables(getTheme(preset as never), isDark)[
        `--smrt-surface-${name}`
      ];

    for (const preset of ['material', 'studio', 'smrt'] as const) {
      it(`${preset} dark ladder steps up: ground <= panel < control < raised`, () => {
        const [ground, panel, control, raised] = [
          'ground',
          'panel',
          'control',
          'raised',
        ].map((k) => luminance(rung(preset, true, k)));
        expect(ground).toBeLessThanOrEqual(panel);
        expect(panel).toBeLessThan(control);
        expect(control).toBeLessThan(raised);
        // Not a near-black collapse: the top rung is clearly above the ground.
        expect(raised / Math.max(ground, 1e-4)).toBeGreaterThan(2);
      });
    }

    it('material dark ladder uses the M3 tonal anchors', () => {
      expect(rung('material', true, 'ground')).toBe('#121316');
      expect(rung('material', true, 'sunken')).toBe('#0d0e11');
    });

    it('studio is flat: panel equals ground in both schemes', () => {
      expect(rung('studio', false, 'ground')).toBe('#ffffff');
      expect(rung('studio', false, 'panel')).toBe('#ffffff');
      expect(rung('studio', true, 'ground')).toBe('#131416');
      expect(rung('studio', true, 'panel')).toBe('#131416');
      // A hair darker in light, lighter in dark.
      expect(luminance(rung('studio', false, 'control'))).toBeLessThan(
        luminance(rung('studio', false, 'panel')),
      );
      expect(luminance(rung('studio', true, 'control'))).toBeGreaterThan(
        luminance(rung('studio', true, 'panel')),
      );
    });

    it('smrt dark ladder is the instrument ladder', () => {
      expect(
        ['ground', 'panel', 'control', 'raised'].map((k) =>
          rung('smrt', true, k),
        ),
      ).toEqual(['#0b0c0e', '#121417', '#181b1f', '#1d2126']);
    });

    it('light ladders separate the panel from the ground except where flat', () => {
      for (const preset of ['material', 'smrt', 'happyvertical'] as const) {
        expect(rung(preset, false, 'panel')).not.toBe(
          rung(preset, false, 'ground'),
        );
      }
    });

    it('glass is translucent with a tinted ground and recessed inputs', () => {
      expect(rung('glass', false, 'ground')).toBe('#f2f2f7');
      expect(rung('glass', true, 'ground')).toBe('#0b0b0f');
      for (const isDark of [false, true]) {
        const vars = generateThemeVariables(getTheme('glass'), isDark);
        expect(vars['--smrt-surface-panel']).toContain('72%');
        expect(vars['--smrt-surface-raised']).toContain('88%');
        expect(vars['--smrt-glass-surface']).toContain('72%');
        expect(vars['--smrt-glass-surface-strong']).toContain('88%');
        expect(vars['--smrt-glass-blur']).toBe('20px');
        expect(vars['--smrt-glass-saturation']).toBe('180%');
      }
    });

    it('Day Shift maps its roles onto the ladder', () => {
      const day = getTheme('happyvertical');
      for (const isDark of [false, true]) {
        const vars = generateThemeVariables(day, isDark);
        const colors = isDark ? day.dark : day.light;
        expect(vars['--smrt-surface-ground']).toBe(colors.background);
        expect(vars['--smrt-surface-panel']).toBe(colors.surface);
        // Raised is the faceplate itself; the bezel hairline lifts it.
        expect(vars['--smrt-surface-raised']).toBe(colors.surface);
        expect(vars['--smrt-hairline-color']).toBe(
          'var(--smrt-color-outline-variant)',
        );
      }
    });

    it('elevations 2..5 are two-layer: contact shadow plus ambient with negative spread', () => {
      for (const preset of availablePresets) {
        if (preset === 'happyvertical') continue;
        for (const isDark of [false, true]) {
          const vars = generateThemeVariables(getTheme(preset), isDark);
          for (const level of [2, 3, 4, 5]) {
            const value = vars[`--smrt-elevation-${level}`];
            const layers = value.match(/0 [-\dpx ]+ color-mix/g);
            expect(layers?.length, `${preset} ${isDark} e${level}`).toBe(2);
            expect(layers?.[1]).toMatch(/ -\d+px color-mix/);
            expect(value).toContain('var(--smrt-shadow-color)');
            if (isDark) expect(value).toContain('var(--smrt-inset-highlight)');
          }
        }
      }
      // Day Shift: elevation 2 is the minimal single contact layer.
      expect(
        generateThemeVariables(getTheme('happyvertical'), false)[
          '--smrt-elevation-3'
        ],
      ).toContain('-2px color-mix');
    });

    it('elevation 1 is the hairline inset in the flat presets', () => {
      for (const preset of ['studio', 'smrt', 'happyvertical'] as const) {
        for (const isDark of [false, true]) {
          expect(
            generateThemeVariables(getTheme(preset), isDark)[
              '--smrt-elevation-1'
            ],
          ).toBe('inset 0 0 0 1px var(--smrt-hairline-color)');
        }
      }
    });

    it('state layers follow each preset', () => {
      const states = (p: string) => {
        const v = generateThemeVariables(getTheme(p as never), false);
        return [
          'hover',
          'pressed',
          'selected',
          'focus',
          'dragged',
          'disabled',
        ].map((k) => v[`--smrt-state-${k}`]);
      };
      expect(states('material')).toEqual([
        '0.08',
        '0.12',
        '0.12',
        '0.12',
        '0.16',
        '0.38',
      ]);
      expect(states('glass').slice(0, 2)).toEqual(['0.10', '0.14']);
      expect(states('studio').slice(0, 2)).toEqual(['0.06', '0.10']);
      expect(states('smrt').slice(0, 3)).toEqual(['0.10', '0.16', '0.14']);
      expect(states('happyvertical').slice(0, 3)).toEqual([
        '0.06',
        '0.10',
        '0.10',
      ]);
    });

    it('controls: weight 500 everywhere, radius per preset', () => {
      const radius: Record<string, string> = {
        material: 'var(--smrt-radius-md)',
        glass: 'var(--smrt-radius-lg)',
        studio: '0.375rem',
        smrt: 'var(--smrt-radius-sm)',
        happyvertical: 'var(--smrt-radius-md)',
      };
      for (const preset of availablePresets) {
        const v = generateThemeVariables(getTheme(preset), false);
        expect(v['--smrt-control-weight']).toBe('500');
        expect(v['--smrt-control-radius']).toBe(radius[preset]);
      }
      expect(
        generateThemeVariables(getTheme('material'), false)[
          '--smrt-control-height'
        ],
      ).toBe('2.75rem');
    });

    it('native chrome: accent/caret primary, thumb is the strong hairline', () => {
      for (const preset of availablePresets) {
        const v = generateThemeVariables(getTheme(preset), true);
        expect(v['--smrt-accent-color']).toBe('var(--smrt-color-primary)');
        expect(v['--smrt-caret-color']).toBe('var(--smrt-color-primary)');
        expect(v['--smrt-selection-background']).toBe(
          'var(--smrt-color-primary-container)',
        );
        expect(v['--smrt-scrollbar-thumb']).toBe(
          'var(--smrt-hairline-strong-color)',
        );
        expect(v['--smrt-scrollbar-track']).toBe('transparent');
      }
    });

    it('every preset defines the info family; smrt has a distinct steel blue', () => {
      for (const preset of availablePresets) {
        for (const isDark of [false, true]) {
          const v = generateThemeVariables(getTheme(preset), isDark);
          for (const t of [
            'info',
            'on-info',
            'info-container',
            'on-info-container',
          ])
            expect(v[`--smrt-color-${t}`], `${preset} ${t}`).toBeTruthy();
          const hasDistinct = preset === 'smrt';
          expect(v['--smrt-color-info'] !== v['--smrt-color-tertiary']).toBe(
            hasDistinct,
          );
          expect(v['--smrt-color-info']).not.toBe(v['--smrt-color-warning']);
        }
      }
    });

    it('createTheme: info follows a supplied tertiary unless set', () => {
      const t = createTheme({
        id: 'info-a',
        name: 'A',
        light: { primary: '#ff6b35', tertiary: '#123456' },
      });
      expect(t.light.info).toBe('#123456');
      const d = createTheme({
        id: 'info-b',
        name: 'B',
        light: { primary: '#ff6b35', tertiary: '#123456', info: '#abcdef' },
      });
      expect(d.light.info).toBe('#abcdef');
    });
  });
});
