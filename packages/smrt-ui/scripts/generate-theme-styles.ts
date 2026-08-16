/**
 * Regenerate the static per-preset stylesheets in `src/themes/styles/` from
 * the theme definitions.
 *
 * Only the two generated `[data-theme="X"][data-color-scheme="…"]` token
 * blocks in each file are rewritten — header comments and hand-authored
 * extras (utilities, keyframes, focus rings) are preserved. The lockstep
 * tests (`src/themes/__tests__/styles-lockstep.test.ts`) verify the files
 * match `generateThemeCSS` output verbatim, so run this after editing any
 * `src/themes/<preset>/index.ts` definition.
 *
 * Usage: pnpm --filter @happyvertical/smrt-ui generate:themes
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateThemeCSS } from '../src/themes/css-generator.js';
import { availablePresets, getTheme } from '../src/themes/registry.js';

const stylesDir = join(import.meta.dirname, '../src/themes/styles');
const SCHEMES = [
  ['light', false],
  ['dark', true],
] as const;

for (const preset of availablePresets) {
  const theme = getTheme(preset);
  const file = join(stylesDir, `${preset}.css`);
  let css = readFileSync(file, 'utf8');

  for (const [scheme, isDark] of SCHEMES) {
    const block = generateThemeCSS(theme, isDark);
    // Generated blocks are flat declaration lists (no nested braces), so a
    // brace-bounded match safely targets exactly one block.
    const pattern = new RegExp(
      `\\[data-theme="${preset}"\\]\\[data-color-scheme="${scheme}"\\]\\s*\\{[^}]*\\}`,
    );
    css = pattern.test(css)
      ? css.replace(pattern, block)
      : `${css.trimEnd()}\n\n${block}\n`;
  }

  writeFileSync(file, css);
  console.log(`regenerated token blocks: src/themes/styles/${preset}.css`);
}
