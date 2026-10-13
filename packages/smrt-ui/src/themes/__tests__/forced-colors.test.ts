import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORCED_COLORS_TOKENS } from '../forced-colors.js';

const baseCss = readFileSync(
  resolve(process.cwd(), 'src/themes/styles/base.css'),
  'utf8',
);

describe('forced-colors tokens', () => {
  it('base.css declares every token in both the media and the attribute block', () => {
    for (const [name, value] of Object.entries(FORCED_COLORS_TOKENS)) {
      const declaration = `${name}: ${value};`;
      const occurrences = baseCss.split(declaration).length - 1;
      expect(occurrences, declaration).toBe(2);
    }
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
    const marker = baseCss.indexOf('Forced colors (#3908)');
    const first = baseCss.indexOf('@media (forced-colors: active) {', marker);
    expect(first).toBeGreaterThan(marker);
    const between = baseCss.slice(marker, first);
    expect(between).not.toContain('@layer');
  });
});
