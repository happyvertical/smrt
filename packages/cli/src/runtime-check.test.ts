/**
 * Runtime check tests
 *
 * Exercises runRuntimeCheck end-to-end against temp-dir manifest fixtures and
 * the formatRuntimeCheckReport renderer. We never mock the filesystem or the
 * ObjectRegistry: each test writes a real `.smrt/manifest.json` into a fresh
 * temp project and drives the public API.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  distinctClasses,
  formatRuntimeCheckReport,
  type ManifestEntryRef,
  runRuntimeCheck,
} from './runtime-check.js';

let tempDir: string;

function writeManifest(root: string, manifest: Record<string, unknown>): void {
  const smrtDir = join(root, '.smrt');
  mkdirSync(smrtDir, { recursive: true });
  writeFileSync(
    join(smrtDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8',
  );
}

function findCodes(findings: Array<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

describe('runRuntimeCheck', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-runtime-check-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a missing project manifest when none is discovered', async () => {
    const result = await runRuntimeCheck(tempDir);

    expect(result.discoveredManifestCount).toBe(0);
    expect(findCodes(result.findings)).toContain('missing-project-manifest');
    expect(result.projectManifestPath).toBeUndefined();
  });

  it('passes for a simple single-class project manifest', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      objects: {
        '@app/example:Widget': {
          className: 'Widget',
          qualifiedName: '@app/example:Widget',
          fields: {
            id: { type: 'text' },
            name: { type: 'text' },
          },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(result.projectPackageName).toBe('@app/example');
    expect(result.projectManifestPath).toBeDefined();
    const codes = findCodes(result.findings);
    expect(codes).not.toContain('missing-project-manifest');
  });

  it('flags a qualified-name mismatch in manifest identity checks', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      objects: {
        Widget: {
          className: 'Widget',
          // qualifiedName intentionally disagrees with packageName:className
          qualifiedName: '@other/pkg:Widget',
          fields: { id: { type: 'text' } },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).toContain('qualified-name-mismatch');
  });

  it('flags a manifest-key mismatch when the key disagrees with identity', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      objects: {
        // Qualified key whose className part does not match the definition.
        '@app/example:Renamed': {
          className: 'Widget',
          fields: { id: { type: 'text' } },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).toContain('manifest-key-mismatch');
  });

  it('flags a manifest-key mismatch when a qualified key disagrees with the container package', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      objects: {
        '@other/pkg:Widget': {
          className: 'Widget',
          fields: { id: { type: 'text' } },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).toContain('manifest-key-mismatch');
  });

  it('warns when a class is missing package identity', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      // No top-level packageName, and the entry has no qualified key.
      objects: {
        Widget: {
          className: 'Widget',
          fields: { id: { type: 'text' } },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).toContain(
      'missing-manifest-package-name',
    );
  });

  it('loads a dependency manifest, hydrates fields, and reports consumer-register + shadow findings', async () => {
    // Create a real dependency package under node_modules with a manifest so
    // loadDependencyManifest / resolvePackageJsonPath / findPackageJsonForResolvedEntry
    // all run against a genuine on-disk package.
    const depName = '@acme/widgets';
    const depDir = join(tempDir, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(depDir, 'dist'), { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({
        name: depName,
        version: '1.0.0',
        main: 'dist/index.js',
        dependencies: { '@happyvertical/smrt-core': '*' },
        exports: { '.': './dist/index.js' },
      }),
      'utf-8',
    );
    writeFileSync(join(depDir, 'dist', 'index.js'), 'module.exports = {};');
    const depManifest = {
      version: '1.0.0',
      packageName: depName,
      objects: {
        '@acme/widgets:Gadget': {
          className: 'Gadget',
          qualifiedName: '@acme/widgets:Gadget',
          fields: {
            id: { type: 'text' },
            color: { type: 'text' },
            weight: { type: 'integer' },
            size: { type: 'integer' },
          },
        },
      },
    };
    writeFileSync(
      join(depDir, 'dist', 'manifest.json'),
      JSON.stringify(depManifest),
      'utf-8',
    );

    // Project manifest declares the dependency and defines a thin "Gadget"
    // shadow (only one non-system field) so the shadow-class heuristic trips.
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      smrtDependencies: [depName],
      objects: {
        '@app/example:Gadget': {
          className: 'Gadget',
          qualifiedName: '@app/example:Gadget',
          fields: {
            id: { type: 'text' },
            label: { type: 'text' },
          },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    const codes = findCodes(result.findings);
    // A consumer with external object deps but no register.js must be flagged.
    expect(codes).toContain('missing-consumer-register');
    // The dependency manifest resolved (no missing-dependency-manifest finding).
    expect(codes).not.toContain('missing-dependency-manifest');
    expect(result.discoveredManifestCount).toBeGreaterThan(0);
  });

  it('does not flag consumer-register when a register.js exists', async () => {
    const depName = '@acme/things';
    const depDir = join(tempDir, 'node_modules', '@acme', 'things');
    mkdirSync(join(depDir, 'dist'), { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({
        name: depName,
        version: '1.0.0',
        main: 'dist/index.js',
        dependencies: { '@happyvertical/smrt-core': '*' },
        exports: { '.': './dist/index.js' },
      }),
      'utf-8',
    );
    writeFileSync(join(depDir, 'dist', 'index.js'), 'module.exports = {};');
    writeFileSync(
      join(depDir, 'dist', 'manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        packageName: depName,
        objects: {
          '@acme/things:Thing': {
            className: 'Thing',
            qualifiedName: '@acme/things:Thing',
            fields: { id: { type: 'text' }, name: { type: 'text' } },
          },
        },
      }),
      'utf-8',
    );

    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      smrtDependencies: [depName],
      objects: {
        '@app/example:Local': {
          className: 'Local',
          qualifiedName: '@app/example:Local',
          fields: { id: { type: 'text' } },
        },
      },
    });
    // Provide the register.js (in the now-created .smrt dir) that satisfies the
    // consumer-registration check.
    writeFileSync(join(tempDir, '.smrt', 'register.js'), '// registered');

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).not.toContain(
      'missing-consumer-register',
    );
  });

  it('hydrates an extends chain and resolves a manifest exposed via package exports', async () => {
    // Dependency package that exposes its manifest only through package.json
    // "exports": { "./manifest.json": ... } — exercising resolveExportedManifestPath.
    const depName = '@acme/base';
    const depDir = join(tempDir, 'node_modules', '@acme', 'base');
    mkdirSync(join(depDir, 'dist'), { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({
        name: depName,
        version: '1.0.0',
        main: 'dist/index.js',
        dependencies: { '@happyvertical/smrt-core': '*' },
        exports: {
          '.': './dist/index.js',
          './manifest.json': './custom-manifest.json',
        },
      }),
      'utf-8',
    );
    writeFileSync(join(depDir, 'dist', 'index.js'), 'module.exports = {};');
    // Note: NOT placed at any of the default candidate paths so the exports
    // fallback branch runs.
    writeFileSync(
      join(depDir, 'custom-manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        packageName: depName,
        objects: {
          '@acme/base:Animal': {
            className: 'Animal',
            qualifiedName: '@acme/base:Animal',
            fields: { id: { type: 'text' }, species: { type: 'text' } },
          },
        },
      }),
      'utf-8',
    );

    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      smrtDependencies: [depName],
      objects: {
        '@app/example:Dog': {
          className: 'Dog',
          qualifiedName: '@app/example:Dog',
          extends: '@acme/base:Animal',
          fields: { id: { type: 'text' }, breed: { type: 'text' } },
        },
      },
    });
    writeFileSync(join(tempDir, '.smrt', 'register.js'), '// registered');

    const result = await runRuntimeCheck(tempDir);

    // The custom-exports manifest must have resolved (no missing finding).
    expect(findCodes(result.findings)).not.toContain(
      'missing-dependency-manifest',
    );
    expect(result.projectPackageName).toBe('@app/example');
  });

  it('hydrates through extendsQualified when two dependencies share the parent name (#4160)', async () => {
    const writeDep = (
      name: string,
      scopeDir: string,
      fields: Record<string, unknown>,
    ) => {
      const depDir = join(tempDir, 'node_modules', '@acme', scopeDir);
      mkdirSync(join(depDir, '.smrt'), { recursive: true });
      writeFileSync(
        join(depDir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          dependencies: { '@happyvertical/smrt-core': '*' },
        }),
        'utf-8',
      );
      writeFileSync(
        join(depDir, '.smrt', 'manifest.json'),
        JSON.stringify({
          version: '1.0.0',
          packageName: name,
          objects: {
            [`${name}:Agreement`]: {
              className: 'Agreement',
              qualifiedName: `${name}:Agreement`,
              fields,
            },
          },
        }),
        'utf-8',
      );
    };
    writeDep('@acme/commerce', 'commerce', {
      id: { type: 'text' },
      customerId: { type: 'text' },
    });
    writeDep('@acme/sales', 'sales', {
      id: { type: 'text' },
      termsJson: { type: 'text' },
    });

    const manifest = (extendsQualified?: string) => ({
      version: '1.0.0',
      packageName: '@app/example',
      smrtDependencies: ['@acme/commerce', '@acme/sales'],
      objects: {
        '@app/example:AdContract': {
          className: 'AdContract',
          qualifiedName: '@app/example:AdContract',
          extends: 'Agreement',
          ...(extendsQualified ? { extendsQualified } : {}),
          fields: {
            id: { type: 'text' },
            customerId: { type: 'text' },
            siteId: { type: 'text' },
          },
        },
      },
    });

    writeManifest(tempDir, manifest());
    writeFileSync(join(tempDir, '.smrt', 'register.js'), '// registered');
    const ambiguous = await runRuntimeCheck(tempDir);
    expect(findCodes(ambiguous.findings)).toContain(
      'ambiguous-extends-reference',
    );

    writeManifest(tempDir, manifest('@acme/commerce:Agreement'));
    const qualified = await runRuntimeCheck(tempDir);
    expect(findCodes(qualified.findings)).not.toContain(
      'ambiguous-extends-reference',
    );
    expect(
      qualified.findings.filter((finding) =>
        finding.message.includes('AdContract'),
      ),
    ).toEqual([]);
  });

  for (const order of ['owner-first', 'copy-first'] as const) {
    it(`does not call a class ambiguous when another manifest carries a consumed copy of it (#4176, ${order})`, async () => {
      const writeDep = (
        name: string,
        scopeDir: string,
        objects: Record<string, unknown>,
      ) => {
        const depDir = join(tempDir, 'node_modules', '@acme', scopeDir);
        mkdirSync(join(depDir, '.smrt'), { recursive: true });
        writeFileSync(
          join(depDir, 'package.json'),
          JSON.stringify({
            name,
            version: '1.0.0',
            dependencies: { '@happyvertical/smrt-core': '*' },
          }),
          'utf-8',
        );
        writeFileSync(
          join(depDir, '.smrt', 'manifest.json'),
          JSON.stringify({ version: '1.0.0', packageName: name, objects }),
          'utf-8',
        );
      };
      const agreement = (fields: Record<string, unknown>) => ({
        className: 'Agreement',
        qualifiedName: '@acme/commerce:Agreement',
        packageName: '@acme/commerce',
        fields,
      });
      writeDep('@acme/commerce', 'commerce', {
        '@acme/commerce:Agreement': agreement({
          id: { type: 'text' },
          customerId: { type: 'text' },
        }),
      });
      // A package manifest may preserve objects it consumed, under their own
      // qualified names and owner: the same class, not a second candidate.
      // (Which copy wins is covered by the distinctClasses tests.)
      writeDep('@acme/reports', 'reports', {
        '@acme/commerce:Agreement': agreement({
          id: { type: 'text' },
          customerId: { type: 'text' },
          retiredField: { type: 'text' },
        }),
      });

      const dependencies = ['@acme/commerce', '@acme/reports'];
      writeManifest(tempDir, {
        version: '1.0.0',
        packageName: '@app/example',
        smrtDependencies:
          order === 'owner-first' ? dependencies : dependencies.reverse(),
        objects: {
          '@app/example:AdContract': {
            className: 'AdContract',
            qualifiedName: '@app/example:AdContract',
            extends: 'Agreement',
            extendsQualified: '@acme/commerce:Agreement',
            fields: { id: { type: 'text' }, siteId: { type: 'text' } },
          },
        },
      });
      writeFileSync(join(tempDir, '.smrt', 'register.js'), '// registered');

      const result = await runRuntimeCheck(tempDir);
      expect(findCodes(result.findings)).not.toContain(
        'ambiguous-extends-reference',
      );
    });
  }

  it('reports a missing dependency manifest for an undeclared SMRT dependency', async () => {
    writeManifest(tempDir, {
      version: '1.0.0',
      packageName: '@app/example',
      smrtDependencies: ['@happyvertical/does-not-exist-xyz'],
      objects: {
        '@app/example:Widget': {
          className: 'Widget',
          qualifiedName: '@app/example:Widget',
          fields: { id: { type: 'text' } },
        },
      },
    });

    const result = await runRuntimeCheck(tempDir);

    expect(findCodes(result.findings)).toContain('missing-dependency-manifest');
  });
});

describe('distinctClasses (#4176)', () => {
  const copy = (
    container: string,
    fields: Record<string, unknown>,
  ): ManifestEntryRef => ({
    // A consumed copy keeps its owner's identity: only the container differs.
    manifestPackageName: '@acme/commerce',
    containerPackageName: container,
    manifestSource: 'dependency',
    key: '@acme/commerce:Agreement',
    definition: {
      className: 'Agreement',
      qualifiedName: '@acme/commerce:Agreement',
      packageName: '@acme/commerce',
      fields,
    } as unknown as ManifestEntryRef['definition'],
  });

  it("keeps the owner's copy of a class in either order", () => {
    const owner = copy('@acme/commerce', { customerId: { type: 'text' } });
    const stale = copy('@acme/reports', { retiredField: { type: 'text' } });
    expect(distinctClasses([owner, stale])).toEqual([owner]);
    expect(distinctClasses([stale, owner])).toEqual([owner]);
  });

  it('keeps distinct classes that share a short name', () => {
    const commerce = copy('@acme/commerce', {});
    const sales: ManifestEntryRef = {
      ...copy('@acme/sales', {}),
      manifestPackageName: '@acme/sales',
      key: '@acme/sales:Agreement',
      definition: {
        className: 'Agreement',
        qualifiedName: '@acme/sales:Agreement',
        fields: {},
      } as unknown as ManifestEntryRef['definition'],
    };
    expect(distinctClasses([commerce, sales])).toHaveLength(2);
  });
});

describe('formatRuntimeCheckReport', () => {
  it('renders heading, manifest details, and a summary by default', () => {
    const report = formatRuntimeCheckReport({
      projectRoot: '/tmp/project',
      projectManifestPath: '/tmp/project/.smrt/manifest.json',
      projectPackageName: '@app/example',
      discoveredManifestCount: 3,
      findings: [
        { severity: 'error', code: 'boom', message: 'It broke' },
        { severity: 'warning', code: 'careful', message: 'Watch out' },
        { severity: 'pass', code: 'ok', message: 'All good' },
      ],
    });

    expect(report).toContain('🧪 SMRT Runtime Check');
    expect(report).toContain(
      'Project manifest: /tmp/project/.smrt/manifest.json',
    );
    expect(report).toContain('Project package: @app/example');
    expect(report).toContain('Discovered manifests: 3');
    expect(report).toContain('❌ It broke');
    expect(report).toContain('⚠️  Watch out');
    expect(report).toContain('✅ All good');
    expect(report).toContain('Summary: 1 passed, 1 warning(s), 1 error(s)');
  });

  it('omits the heading when heading:false is passed', () => {
    const report = formatRuntimeCheckReport(
      {
        projectRoot: '/tmp/project',
        discoveredManifestCount: 0,
        findings: [],
      },
      { heading: false },
    );

    expect(report).not.toContain('🧪 SMRT Runtime Check');
    expect(report).toContain('Discovered manifests: 0');
    expect(report).toContain('Summary: 0 passed, 0 warning(s), 0 error(s)');
  });

  it('handles a report with no optional manifest fields', () => {
    const report = formatRuntimeCheckReport({
      projectRoot: '/tmp/project',
      discoveredManifestCount: 1,
      findings: [{ severity: 'pass', code: 'ok', message: 'Fine' }],
    });

    expect(report).not.toContain('Project manifest:');
    expect(report).not.toContain('Project package:');
    expect(report).toContain('✅ Fine');
  });
});
