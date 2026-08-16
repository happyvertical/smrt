/**
 * Static stylesheet lockstep (#1586, all presets).
 *
 * Every built-in preset ships a static stylesheet whose two
 * `[data-theme][data-color-scheme]` token blocks must be the verbatim output
 * of the theme generator — ThemeProvider defaults built-in presets to this
 * static delivery path, so drift between the theme definitions and the
 * shipped CSS would silently change rendered values. Run
 * `pnpm --filter @happyvertical/smrt-ui generate:themes` to regenerate after
 * editing a preset definition.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateThemeCSS } from '../css-generator.js';
import { availablePresets, getTheme } from '../registry.js';

// Resolved from process.cwd() (NOT import.meta.url): the smrt-vitest plugin
// runs each package's suite with cwd === the package root.
describe('static stylesheets match the generator verbatim (#1586)', () => {
  for (const preset of availablePresets) {
    const theme = getTheme(preset);
    const staticCss = readFileSync(
      join(process.cwd(), `src/themes/styles/${preset}.css`),
      'utf8',
    );

    for (const [scheme, isDark] of [
      ['light', false],
      ['dark', true],
    ] as const) {
      it(`${preset} ${scheme} block matches generateThemeCSS output`, () => {
        expect(staticCss).toContain(generateThemeCSS(theme, isDark));
      });
    }
  }
});
