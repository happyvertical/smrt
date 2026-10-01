import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panels = [
  'ContentClaimAuditTool',
  'ContentCorrectionsTool',
  'ContentVersionsTool',
  'ContentTransparencyTool',
  'ContentGovernancePanel',
  'ContentTransparencyReport',
];

describe('governance panels lay out by their container', () => {
  for (const name of panels) {
    const source = readFileSync(
      new URL(`./${name}.svelte`, import.meta.url),
      'utf8',
    );

    it(`${name} is a size container and has no viewport width queries`, () => {
      expect(source).toMatch(/container-type:\s*inline-size/);
      expect(source).not.toMatch(/@media\s*\((?:min|max)-width/);
    });
  }

  it('cards read the shared card tokens', () => {
    for (const name of panels.slice(0, 4)) {
      const source = readFileSync(
        new URL(`./${name}.svelte`, import.meta.url),
        'utf8',
      );
      expect(source).not.toMatch(
        /border: 1px solid var\(--smrt-color-outline-variant\);/,
      );
    }
  });
});
