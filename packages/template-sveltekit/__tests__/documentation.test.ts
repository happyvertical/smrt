import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageReadme = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
const projectReadme = readFileSync(
  join(__dirname, '..', 'template', 'README.md'),
  'utf8',
);

describe('practical documentation', () => {
  it.each([
    ['package', packageReadme],
    ['generated project', projectReadme],
  ])('covers the ten required sections in the %s README', (_name, readme) => {
    for (let section = 1; section <= 10; section += 1) {
      expect(readme).toMatch(new RegExp(`^## ${section}\\. `, 'm'));
    }
  });

  it('documents current database and browser-tool behavior', () => {
    expect(projectReadme).toContain('pnpm db:migrate');
    expect(projectReadme).toContain('registerWebMcpTools');
    expect(projectReadme).toContain('collectionDefinitions');
    expect(projectReadme).toMatch(/custom actions.*not yet wired/is);
    expect(projectReadme).not.toMatch(/```bash[^`]*smrt db:setup/s);
  });

  it('uses s-m-r-t in user-facing prose', () => {
    expect(packageReadme).toContain('s-m-r-t 0.38.25');
    expect(projectReadme).toContain('s-m-r-t 0.38.25');
  });
});
