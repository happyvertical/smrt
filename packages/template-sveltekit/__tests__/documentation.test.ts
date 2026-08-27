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
const templateDirectory = join(__dirname, '..', 'template');
const templatePackage = JSON.parse(
  readFileSync(join(templateDirectory, 'package.json'), 'utf8'),
) as { dependencies: Record<string, string> };

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
    expect(projectReadme).toContain('webMcpToolDefinitions');
    expect(packageReadme).toContain('registerWebMcpTools');
    expect(packageReadme).toContain(
      "dependencies['@happyvertical/smrt-core']",
    );
    expect(packageReadme).not.toMatch(/smrt-web@\^\d+\.\d+\.\d+/);
    expect(projectReadme).not.toMatch(/smrt-web@\^\d+\.\d+\.\d+/);
    expect(projectReadme).toContain(
      'Omitted policy exposes all `read`-effect tools',
    );
    expect(projectReadme).toMatch(
      /custom actions explicitly declared as reads/i,
    );
    expect(projectReadme).toContain("effects: ['read', 'write']");
    expect(projectReadme).toMatch(/undeclared custom effects fail\s+closed/is);
    expect(projectReadme).not.toMatch(/```bash[^`]*smrt db:setup/s);
  });

  it('wires WebMCP into the generated root layout on the synchronized release line', () => {
    expect(templatePackage.dependencies['@happyvertical/smrt-web']).toMatch(
      /^\^\d+\.\d+\.\d+$/,
    );
    expect(templatePackage.dependencies['@happyvertical/smrt-web']).toBe(
      templatePackage.dependencies['@happyvertical/smrt-core'],
    );
    expect(templatePackage.dependencies['@happyvertical/smrt-core']).toMatch(
      /^\^\d+\.\d+\.\d+$/,
    );
  });

  it('uses s-m-r-t in user-facing prose', () => {
    expect(packageReadme).toContain('s-m-r-t 0.38.25');
    expect(projectReadme).toContain('s-m-r-t 0.38.25');
  });
});
