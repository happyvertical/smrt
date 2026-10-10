/**
 * `@happyvertical/smrt-ui/themes/presets` must load in plain Node (no Svelte
 * compiler, no DOM) from the BUILT package, resolved through its exports map.
 * Needs `pnpm build` first; turbo's `test` task depends on it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { availablePresets, themePresets, themes } from '../presets';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('themes/presets subpath', () => {
  it('loads from the built package in plain Node', () => {
    expect(
      existsSync(join(packageRoot, 'dist/themes/presets.js')),
      'dist/themes/presets.js missing: run `pnpm build` first',
    ).toBe(true);
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import('@happyvertical/smrt-ui/themes/presets');
         console.log(JSON.stringify(m.themePresets.map((p) => [p.id, p.label, p.light.primary, p.dark.primary])));`,
      ],
      { cwd: packageRoot, encoding: 'utf-8' },
    );
    expect(JSON.parse(out)).toEqual(
      themePresets.map((p) => [p.id, p.label, p.light.primary, p.dark.primary]),
    );
  });

  it('lists every built-in preset with id, label and palettes', () => {
    expect(themePresets.map((p) => p.id)).toEqual(availablePresets);
    for (const preset of themePresets) {
      expect(preset.label).toBe(themes[preset.id].name);
      expect(preset.light.primary).toBeTruthy();
      expect(preset.dark.primary).toBeTruthy();
    }
  });
});
