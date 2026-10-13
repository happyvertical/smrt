/**
 * Doctor's unlayered-reset scan (#3862). Unlayered `*` resets beat every smrt
 * `@layer`, so the scanner must flag them and must stay quiet for the
 * layered forms the styling docs recommend.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dependsOnSmrtUi,
  findUnlayeredResets,
  findUnlayeredResetsInSvelte,
  scanProjectForUnlayeredResets,
} from '../cascade-layers-reset-scan.mjs';

const UNIVERSAL_RESET = '*, *::before, *::after { margin: 0; padding: 0; }';

describe('findUnlayeredResets', () => {
  it('flags an unlayered universal reset', () => {
    const findings = findUnlayeredResets(UNIVERSAL_RESET);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 1, kind: 'rule' });
    expect(findings[0].selector).toBe('*, *::before, *::after');
  });

  it('flags html and body margin or padding resets', () => {
    expect(findUnlayeredResets('html, body { margin: 0; }')).toHaveLength(1);
    expect(findUnlayeredResets('body { padding: 0 1rem; }')).toHaveLength(1);
  });

  it('does not flag the same reset inside @layer smrt.reset', () => {
    const css = `@layer smrt.reset, smrt.structure, smrt.theme;\n@layer smrt.reset {\n${UNIVERSAL_RESET}\n}`;
    expect(findUnlayeredResets(css)).toEqual([]);
  });

  it('does not flag a reset inside Tailwind @layer base', () => {
    const css = `@layer theme, base, components, utilities;\n@layer base {\n${UNIVERSAL_RESET}\n}`;
    expect(findUnlayeredResets(css)).toEqual([]);
  });

  it('does not flag a layered @import of a reset stylesheet', () => {
    expect(
      findUnlayeredResets(
        '@import url("normalize.css/normalize.css") layer(smrt.reset);',
      ),
    ).toEqual([]);
    expect(
      findUnlayeredResets('@import "sanitize.css" layer(smrt.reset);'),
    ).toEqual([]);
  });

  it('flags an unlayered @import of a reset stylesheet', () => {
    const findings = findUnlayeredResets(
      '@import url("normalize.css/normalize.css");',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'import', line: 1 });
  });

  it('ignores ordinary unlayered app rules that set no reset declaration', () => {
    expect(findUnlayeredResets('.card { margin: 1rem; }')).toEqual([]);
    expect(findUnlayeredResets('* { box-sizing: border-box; }')).toEqual([]);
  });

  it('does not flag an anonymous layer import of a reset stylesheet', () => {
    expect(findUnlayeredResets('@import "normalize.css" layer;')).toEqual([]);
  });

  it('scans a large minified stylesheet quickly and still finds the reset', () => {
    const rules = Array.from(
      { length: 20000 },
      (_, i) => `.r${i}{color:red}`,
    ).join('\n');
    const started = Date.now();
    const findings = findUnlayeredResets(`${rules}\n${UNIVERSAL_RESET}`);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(20001);
  });

  it('flags a reset inside an unlayered @media group', () => {
    const css = `@media (min-width: 40rem) {\n  *, *::before { padding: 0; }\n}`;
    const findings = findUnlayeredResets(css);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('reports the line of the selector, ignoring comments and string content', () => {
    const css = [
      '/* margin: 0; in a comment { */',
      '.badge::before { content: "} * { margin: 0 }"; }',
      '*',
      '{ margin: 0; }',
    ].join('\n');
    const findings = findUnlayeredResets(css);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });
});

describe('findUnlayeredResetsInSvelte', () => {
  it('maps findings to the line inside the file, not the style body', () => {
    const source = [
      '<div>hi</div>',
      '<style>',
      '  *, *::before { margin: 0; }',
      '</style>',
      '',
    ].join('\n');
    const findings = findUnlayeredResetsInSvelte(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it('flags a :global(...) reset, which Svelte does not scope', () => {
    const source =
      '<style>\n:global(*), :global(*::before) { margin: 0; padding: 0; }\n</style>';
    const findings = findUnlayeredResetsInSvelte(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('flags rules inside a :global { ... } block', () => {
    const source = '<style>\n:global {\n  * { padding: 0; }\n}\n</style>';
    const findings = findUnlayeredResetsInSvelte(source);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(3);
  });

  it('does not flag a scoped element that only :global wraps in a non-universal selector', () => {
    expect(
      findUnlayeredResetsInSvelte(
        '<style>\n:global(body) h1 { margin: 0; }\n</style>',
      ),
    ).toEqual([]);
  });

  it('is quiet for a layered style block', () => {
    const source = `<style>\n@layer smrt.theme {\n  ${UNIVERSAL_RESET}\n}\n</style>`;
    expect(findUnlayeredResetsInSvelte(source)).toEqual([]);
  });
});

describe('dependsOnSmrtUi', () => {
  it('detects smrt-ui or smrt-svelte in any dependency section', () => {
    expect(
      dependsOnSmrtUi({
        dependencies: { '@happyvertical/smrt-ui': '0.55.17' },
      }),
    ).toBe(true);
    expect(
      dependsOnSmrtUi({
        devDependencies: { '@happyvertical/smrt-svelte': '0.55.17' },
      }),
    ).toBe(true);
    expect(
      dependsOnSmrtUi({
        dependencies: { '@happyvertical/smrt-core': '0.55.17' },
      }),
    ).toBe(false);
    expect(dependsOnSmrtUi(null)).toBe(false);
  });
});

describe('scanProjectForUnlayeredResets', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function project(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'smrt-cascade-'));
    dirs.push(root);
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content);
    }
    return root;
  }

  it('skips projects that do not depend on smrt-ui or smrt-svelte', async () => {
    const root = await project({ 'src/app.css': UNIVERSAL_RESET });
    const result = scanProjectForUnlayeredResets(root, { packageJson: {} });
    expect(result).toEqual({ applies: false, filesScanned: 0, findings: [] });
  });

  it('flags an unlayered reset in app.css and a Svelte style block, skipping node_modules and dist', async () => {
    const root = await project({
      'package.json': '{}',
      'src/app.css': UNIVERSAL_RESET,
      'src/routes/+page.svelte': `<p>x</p>\n<style>\n${UNIVERSAL_RESET}\n</style>\n`,
      'src/layered.css': `@layer smrt.reset {\n${UNIVERSAL_RESET}\n}\n`,
      'node_modules/pkg/reset.css': UNIVERSAL_RESET,
      'dist/out.css': UNIVERSAL_RESET,
      '.svelte-kit/gen.css': UNIVERSAL_RESET,
    });
    const result = scanProjectForUnlayeredResets(root, {
      packageJson: { dependencies: { '@happyvertical/smrt-ui': '0.55.17' } },
    });
    expect(result.applies).toBe(true);
    expect(result.filesScanned).toBe(3);
    expect(
      result.findings.map((finding) => [finding.file, finding.line]).sort(),
    ).toEqual([
      ['src/app.css', 1],
      ['src/routes/+page.svelte', 3],
    ]);
  });

  it('scans a root app.css and can run without the dependency gate', async () => {
    const root = await project({ 'app.css': UNIVERSAL_RESET });
    const result = scanProjectForUnlayeredResets(root, {
      requireSmrtDependency: false,
    });
    expect(result.applies).toBe(true);
    expect(result.findings.map((finding) => finding.file)).toEqual(['app.css']);
  });
});
