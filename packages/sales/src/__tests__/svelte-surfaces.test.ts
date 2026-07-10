import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

describe('reusable sales Svelte surfaces', () => {
  for (const component of ['LeadList', 'OpportunityBoard', 'SalesDetail']) {
    it(`compiles ${component} without warnings`, async () => {
      const filename = new URL(
        `../svelte/components/${component}.svelte`,
        import.meta.url,
      );
      const source = await readFile(filename, 'utf8');
      const result = compile(source, {
        filename: filename.pathname,
        generate: 'client',
        modernAst: true,
      });
      expect(result.warnings).toEqual([]);
    });
  }
});
