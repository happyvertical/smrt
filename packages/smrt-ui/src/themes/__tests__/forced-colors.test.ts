import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORCED_COLORS_TOKENS } from '../forced-colors.js';

const read = (name: string) =>
  readFileSync(resolve(process.cwd(), 'src/themes/styles', name), 'utf8');
const baseCss = read('base.css');
const mediaCss = read('forced-colors.css');

describe('forced-colors tokens', () => {
  it('declares every token once in the media sheet and once in the attribute block', () => {
    for (const [name, value] of Object.entries(FORCED_COLORS_TOKENS)) {
      const declaration = `${name}: ${value};`;
      expect(
        mediaCss.split(declaration).length - 1,
        `media ${declaration}`,
      ).toBe(1);
      expect(baseCss.split(declaration).length - 1, `attr ${declaration}`).toBe(
        1,
      );
    }
  });

  it('loads the media sheet through a conditional import', () => {
    expect(baseCss).toContain(
      "@import url('./forced-colors.css') (forced-colors: active);",
    );
  });

  it('keeps shadows inert but composable, never `none`', () => {
    for (const [name, value] of Object.entries(FORCED_COLORS_TOKENS)) {
      if (/elevation|inset-highlight/.test(name)) {
        expect(value).not.toBe('none');
        expect(value).toContain('transparent');
      }
    }
  });

  it('keeps the token blocks outside any cascade layer', () => {
    // Preset token blocks are unlayered; only an unlayered rule beats them.
    expect(mediaCss).not.toContain('@layer');
    const attr = baseCss.indexOf(
      '[data-forced-colors][data-theme][data-color-scheme] {',
    );
    expect(attr).toBeGreaterThan(0);
    const before = baseCss.slice(0, attr);
    // The last `@layer` block before it has closed (balanced braces).
    const tail = before.slice(before.lastIndexOf('@layer smrt.theme {'));
    expect(tail.split('{').length).toBe(tail.split('}').length);
  });
});
