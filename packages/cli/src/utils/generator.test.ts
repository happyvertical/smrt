/**
 * Tests for the template generator utility (utils/generator.ts).
 *
 * These exercise the exported `generate()` entry point end-to-end against real
 * temporary directories (no DB, no network). The internal helpers
 * (overlayTemplate, mergePackageJson, processPlaceholders, validateBaseGenerator)
 * are covered through `generate()` using a `local` template source so no base
 * generator is spawned.
 */

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplateConfig, TemplateSource } from '../loaders/index.js';
import { generate } from './generator.js';

// Mock child_process so runBaseGenerator() can be driven deterministically
// without depending on installed tooling. `node:child_process` cannot be
// `vi.spyOn`'d in ESM (non-configurable namespace), so we mock the module and
// capture the spawned EventEmitter via a shared handle.
const spawnHandle: {
  proc: EventEmitter | null;
  calls: Array<[string, string[], unknown]>;
} = { proc: null, calls: [] };

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], opts: unknown) => {
    const proc = new EventEmitter();
    spawnHandle.proc = proc;
    spawnHandle.calls.push([command, args, opts]);
    return proc;
  },
}));

describe('utils/generator generate()', () => {
  let workDir: string;
  let templateDir: string;
  let outputDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'smrt-gen-'));
    templateDir = join(workDir, 'tpl');
    outputDir = join(workDir, 'out');
    // Silence the generator's progress logging.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(workDir, { recursive: true, force: true });
  });

  /** Build a `local` template source with a `template/` directory of files. */
  function makeLocalTemplate(files: Record<string, string>): TemplateSource {
    const tplFilesDir = join(templateDir, 'template');
    mkdirSync(tplFilesDir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = join(tplFilesDir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
    return { type: 'local', location: templateDir, resolved: templateDir };
  }

  function baseConfig(overrides: Partial<TemplateConfig> = {}): TemplateConfig {
    return {
      name: 'test-template',
      description: 'A test template',
      framework: 'sveltekit',
      dependencies: { '@happyvertical/smrt-core': '^1.0.0' },
      devDependencies: { vitest: '^1.0.0' },
      ...overrides,
    };
  }

  it('copies template files and creates a package.json from scratch', async () => {
    const source = makeLocalTemplate({
      'src/index.ts': 'export const x = 1;\n',
      'README.md': '# Hello\n',
    });
    const config = baseConfig();

    await generate(source, config, {
      template: 'test',
      name: 'my-site',
      outputDir,
    });

    const copied = await readFile(join(outputDir, 'src/index.ts'), 'utf-8');
    expect(copied).toContain('export const x = 1;');

    const pkg = JSON.parse(
      await readFile(join(outputDir, 'package.json'), 'utf-8'),
    );
    expect(pkg.name).toBe('my-site');
    // Dependencies are merged in.
    expect(pkg.dependencies['@happyvertical/smrt-core']).toBe('^1.0.0');
    expect(pkg.devDependencies.vitest).toBe('^1.0.0');
    // Gnode workflow scripts are injected when missing.
    expect(pkg.scripts['workflow:research']).toContain('research.ts');
    expect(pkg.scripts['workflow:report']).toContain('report.ts');
  });

  it('merges into an existing package.json without clobbering existing scripts', async () => {
    const source = makeLocalTemplate({
      'package.json': JSON.stringify({
        name: 'original',
        version: '9.9.9',
        scripts: { 'workflow:research': 'echo existing', build: 'tsc' },
        dependencies: { existing: '1.0.0' },
      }),
    });

    await generate(source, baseConfig(), {
      template: 'test',
      name: 'renamed-site',
      outputDir,
    });

    const pkg = JSON.parse(
      await readFile(join(outputDir, 'package.json'), 'utf-8'),
    );
    // Name overwritten with project name.
    expect(pkg.name).toBe('renamed-site');
    // Existing scripts preserved; workflow scripts NOT re-added because the
    // key already exists.
    expect(pkg.scripts.build).toBe('tsc');
    expect(pkg.scripts['workflow:research']).toBe('echo existing');
    expect(pkg.scripts['workflow:report']).toBeUndefined();
    // Existing + template deps both present.
    expect(pkg.dependencies.existing).toBe('1.0.0');
    expect(pkg.dependencies['@happyvertical/smrt-core']).toBe('^1.0.0');
  });

  it('processes function and string placeholders across text files', async () => {
    const source = makeLocalTemplate({
      'site.config.ts':
        'export const site = "{{SITE_NAME}}"; export const lat = {{LATITUDE}};\n',
      'README.md': '# {{SITE_NAME}} in {{LOCATION}}\n',
      'binary.png': 'not-processed-because-extension',
    });
    const config = baseConfig({
      placeholders: {
        '{{SITE_NAME}}': (ctx) => ctx.siteName,
        '{{LATITUDE}}': (ctx) => String(ctx.latitude),
        '{{LOCATION}}': 'Static City',
      },
    });

    await generate(source, config, {
      template: 'test',
      name: 'my-town-site',
      outputDir,
      site: { location: 'Bentley, AB', latitude: 52.07, longitude: -114.1 },
    });

    const cfg = await readFile(join(outputDir, 'site.config.ts'), 'utf-8');
    // siteName is derived from the project name: "My Town Site".
    expect(cfg).toContain('"My Town Site"');
    expect(cfg).toContain('lat = 52.07');

    const readme = await readFile(join(outputDir, 'README.md'), 'utf-8');
    expect(readme).toContain('My Town Site in Static City');

    // The .png file is not in the processed extensions list and is untouched.
    const png = await readFile(join(outputDir, 'binary.png'), 'utf-8');
    expect(png).toBe('not-processed-because-extension');
  });

  it('derives siteName and defaults for site options when not provided', async () => {
    const source = makeLocalTemplate({
      'meta.txt': '{{NAME}}|{{TZ}}|{{LON}}',
    });
    const config = baseConfig({
      placeholders: {
        '{{NAME}}': (ctx) => ctx.siteName,
        '{{TZ}}': (ctx) => ctx.timezone,
        '{{LON}}': (ctx) => String(ctx.longitude),
      },
    });

    await generate(source, config, {
      template: 'test',
      name: 'hello_world',
      outputDir,
    });

    const meta = await readFile(join(outputDir, 'meta.txt'), 'utf-8');
    // hello_world -> Hello World; defaults: timezone America/Edmonton, lon 0.
    expect(meta).toBe('Hello World|America/Edmonton|0');
  });

  it('skips placeholder processing when the map is empty', async () => {
    const source = makeLocalTemplate({ 'a.txt': '{{UNTOUCHED}}' });
    const config = baseConfig({ placeholders: {} });

    await generate(source, config, {
      template: 'test',
      name: 'site',
      outputDir,
    });

    const a = await readFile(join(outputDir, 'a.txt'), 'utf-8');
    expect(a).toBe('{{UNTOUCHED}}');
  });

  it('honors a custom templateDir from config', async () => {
    // Place files in a custom subdirectory instead of the default template/.
    const customDir = join(templateDir, 'custom-files');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'custom.txt'), 'from-custom-dir');
    const source: TemplateSource = {
      type: 'local',
      location: templateDir,
      resolved: templateDir,
    };
    const config = baseConfig();
    (config as Record<string, unknown>).templateDir = 'custom-files';

    await generate(source, config, {
      template: 'test',
      name: 'site',
      outputDir,
    });

    const out = await readFile(join(outputDir, 'custom.txt'), 'utf-8');
    expect(out).toBe('from-custom-dir');
  });

  it('falls back to the overlay/ directory when no template/ exists', async () => {
    const overlayDir = join(templateDir, 'overlay');
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(join(overlayDir, 'overlaid.txt'), 'overlay-content');
    const source: TemplateSource = {
      type: 'local',
      location: templateDir,
      resolved: templateDir,
    };

    await generate(source, baseConfig(), {
      template: 'test',
      name: 'site',
      outputDir,
    });

    const out = await readFile(join(outputDir, 'overlaid.txt'), 'utf-8');
    expect(out).toBe('overlay-content');
  });

  it('throws when no template files are found and no base generator', async () => {
    mkdirSync(templateDir, { recursive: true });
    const source: TemplateSource = {
      type: 'local',
      location: templateDir,
      resolved: templateDir,
    };

    await expect(
      generate(source, baseConfig(), {
        template: 'test',
        name: 'site',
        outputDir,
      }),
    ).rejects.toThrow(/No template files found/);
  });

  it('resolves npm template source relative to the resolved file dirname', async () => {
    // For npm sources, baseDir is dirname(source.resolved). Put a template/
    // dir next to a fake resolved entry file.
    const pkgDir = join(workDir, 'npm-pkg');
    const tplFilesDir = join(pkgDir, 'template');
    mkdirSync(tplFilesDir, { recursive: true });
    writeFileSync(join(tplFilesDir, 'npm.txt'), 'npm-template');
    const source: TemplateSource = {
      type: 'npm',
      location: '@scope/pkg',
      resolved: join(pkgDir, 'index.js'),
    };

    await generate(source, baseConfig(), {
      template: 'test',
      name: 'site',
      outputDir,
    });

    const out = await readFile(join(outputDir, 'npm.txt'), 'utf-8');
    expect(out).toBe('npm-template');
  });

  it('throws for git template source when __tempDir is missing', async () => {
    const source: TemplateSource = {
      type: 'git',
      location: 'github:user/repo',
      resolved: '',
    };

    await expect(
      generate(source, baseConfig(), {
        template: 'test',
        name: 'site',
        outputDir,
      }),
    ).rejects.toThrow(/Git template temp directory not found/);
  });

  it('uses the __tempDir for git template sources', async () => {
    const gitTemp = join(workDir, 'git-temp');
    const tplFilesDir = join(gitTemp, 'template');
    mkdirSync(tplFilesDir, { recursive: true });
    writeFileSync(join(tplFilesDir, 'git.txt'), 'git-template');
    const source: TemplateSource = {
      type: 'git',
      location: 'github:user/repo',
      resolved: '',
    };
    const config = baseConfig();
    (config as Record<string, unknown>).__tempDir = gitTemp;

    await generate(source, config, {
      template: 'test',
      name: 'site',
      outputDir,
    });

    const out = await readFile(join(outputDir, 'git.txt'), 'utf-8');
    expect(out).toBe('git-template');
  });

  it('throws on an unknown source type', async () => {
    const source = {
      type: 'ftp',
      location: 'x',
      resolved: 'y',
    } as unknown as TemplateSource;

    await expect(
      generate(source, baseConfig(), {
        template: 'test',
        name: 'site',
        outputDir,
      }),
    ).rejects.toThrow(/Unknown source type: ftp/);
  });

  describe('base generator validation (security)', () => {
    beforeEach(() => {
      spawnHandle.proc = null;
      spawnHandle.calls = [];
    });

    function configWithBaseGen(
      baseGenerator: NonNullable<TemplateConfig['baseGenerator']>,
    ): TemplateConfig {
      return baseConfig({ baseGenerator });
    }

    it('rejects a non-whitelisted base generator command', async () => {
      const source: TemplateSource = {
        type: 'local',
        location: templateDir,
        resolved: templateDir,
      };
      const config = configWithBaseGen({ command: 'rm', args: ['-rf', '/'] });

      await expect(
        generate(source, config, {
          template: 'test',
          name: 'site',
          outputDir,
        }),
      ).rejects.toThrow(/not allowed/);
    });

    it('rejects an output directory containing shell metacharacters', async () => {
      const source: TemplateSource = {
        type: 'local',
        location: templateDir,
        resolved: templateDir,
      };
      const config = configWithBaseGen({ command: 'npx', args: ['{DIR}'] });

      await expect(
        generate(source, config, {
          template: 'test',
          name: 'site',
          outputDir: join(outputDir, 'evil; rm -rf'),
        }),
      ).rejects.toThrow(/dangerous characters/);
    });

    it('rejects a base generator argument with dangerous characters after replacement', async () => {
      const source: TemplateSource = {
        type: 'local',
        location: templateDir,
        resolved: templateDir,
      };
      const config = configWithBaseGen({
        command: 'npx',
        args: ['--flag=$(whoami)'],
      });

      await expect(
        generate(source, config, {
          template: 'test',
          name: 'site',
          outputDir,
        }),
      ).rejects.toThrow(/dangerous characters/);
    });

    /** Wait for spawn() to be invoked, then run an action against the proc. */
    async function withSpawnedProc(act: (proc: EventEmitter) => void) {
      // Allow the spawn call to register close/error listeners.
      for (let i = 0; i < 50 && !spawnHandle.proc; i++) {
        await new Promise((r) => setImmediate(r));
      }
      if (!spawnHandle.proc) throw new Error('spawn was never called');
      act(spawnHandle.proc);
    }

    it('runs a whitelisted base generator and resolves on exit code 0', async () => {
      const source = makeLocalTemplate({ 'a.txt': 'hi' });
      const config = configWithBaseGen({
        command: 'npx',
        args: ['create-thing', '{DIR}'],
      });

      const promise = generate(source, config, {
        template: 'test',
        name: 'site',
        outputDir,
      });
      await withSpawnedProc((proc) => proc.emit('close', 0));
      await promise;

      // {DIR} placeholder is replaced with the outputDir and shell is disabled.
      expect(spawnHandle.calls[0][0]).toBe('npx');
      expect(spawnHandle.calls[0][1]).toEqual(['create-thing', outputDir]);
      expect(spawnHandle.calls[0][2]).toMatchObject({ shell: false });
    });

    it('rejects when the base generator exits with a non-zero code', async () => {
      const source = makeLocalTemplate({ 'a.txt': 'hi' });
      const config = configWithBaseGen({ command: 'pnpm', args: ['x'] });

      const promise = generate(source, config, {
        template: 'test',
        name: 'site',
        outputDir,
      });
      await withSpawnedProc((proc) => proc.emit('close', 1));

      await expect(promise).rejects.toThrow(/exited with code 1/);
    });

    it('rejects when the base generator process emits an error', async () => {
      const source = makeLocalTemplate({ 'a.txt': 'hi' });
      const config = configWithBaseGen({ command: 'yarn', args: ['x'] });

      const promise = generate(source, config, {
        template: 'test',
        name: 'site',
        outputDir,
      });
      await withSpawnedProc((proc) =>
        proc.emit('error', new Error('spawn failed')),
      );

      await expect(promise).rejects.toThrow(/spawn failed/);
    });

    it('returns without copying when base generator runs but no template dir exists', async () => {
      // baseGenerator present + no template/overlay dir => overlayTemplate
      // returns early (no throw). The base generator is responsible for
      // creating outputDir, so create it here to mirror that contract.
      mkdirSync(templateDir, { recursive: true });
      mkdirSync(outputDir, { recursive: true });
      const source: TemplateSource = {
        type: 'local',
        location: templateDir,
        resolved: templateDir,
      };
      const config = configWithBaseGen({ command: 'npm', args: ['x'] });

      const promise = generate(source, config, {
        template: 'test',
        name: 'site',
        outputDir,
      });
      await withSpawnedProc((proc) => proc.emit('close', 0));
      await promise;

      // package.json is created since mergePackageJson always runs.
      const pkg = JSON.parse(
        await readFile(join(outputDir, 'package.json'), 'utf-8'),
      );
      expect(pkg.name).toBe('site');
    });
  });
});
