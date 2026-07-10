import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildWorkbenchProject,
  discoverWorkbenchTargets,
  resolveWorkbenchScope,
} from '../discovery.js';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

describe('resolveWorkbenchScope', () => {
  it('uses aggregate workspace scope at the repo root', () => {
    const scope = resolveWorkbenchScope(repoRoot);

    expect(scope.mode).toBe('workspace');
    expect(scope.projectRoot).toBe(repoRoot);
    expect(scope.packageName).toBeUndefined();
  });

  it('uses package scope inside a workspace package', () => {
    const scope = resolveWorkbenchScope(resolve(repoRoot, 'packages/content'));

    expect(scope.mode).toBe('package');
    expect(scope.packageName).toBe('@happyvertical/smrt-content');
  });

  it('uses the nearest package root for a consumer project', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-'));
    const nestedDir = join(projectRoot, 'src', 'features');
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'consumer-app' }),
    );

    try {
      const scope = resolveWorkbenchScope(nestedDir);
      expect(scope.mode).toBe('consumer');
      expect(scope.projectRoot).toBe(projectRoot);
      expect(scope.packageName).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('buildWorkbenchProject', () => {
  it('filters package scope to the selected package', async () => {
    const scope = resolveWorkbenchScope(resolve(repoRoot, 'packages/content'));
    const project = await buildWorkbenchProject(scope);

    expect(project.packages.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-content',
    ]);
    expect(project.packages[0]?.scripts.workbench).toBeUndefined();
    expect(project.packages[0]?.api.objectNames).toContain(
      '@happyvertical/smrt-content:Content',
    );
    expect(
      project.packages[0]?.api.objects.find(
        (object) => object.className === 'Content',
      )?.description,
    ).toContain('Structured content object with metadata and body text');
    expect(
      project.packages[0]?.api.objects.find(
        (object) => object.className === 'Content',
      )?.typedocPath,
    ).toContain('docs/content/api/content/classes/Content.md');
    expect(project.packages[0]?.api.restEndpoints).toContainEqual(
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/contents',
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: 'limit',
            location: 'query',
          }),
        ]),
      }),
    );
    expect(project.packages[0]?.api.cliCommands).toContainEqual(
      expect.objectContaining({
        command: 'content:list',
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: '--where',
            location: 'option',
          }),
        ]),
      }),
    );
    expect(project.packages[0]?.api.mcpTools).toContainEqual(
      expect.objectContaining({
        toolName: 'content_list',
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: 'where',
            location: 'input',
          }),
        ]),
      }),
    );
  });
});

describe('discoverWorkbenchTargets', () => {
  it('discovers route-owning package workbench modules', async () => {
    const targets = await discoverWorkbenchTargets(repoRoot, 'workspace');
    const packageNames = targets.map((target) => target.packageName).sort();

    expect(packageNames).toContain('@happyvertical/smrt-assets');
    expect(packageNames).toContain('@happyvertical/smrt-content');
    expect(packageNames).toContain('@happyvertical/smrt-images');
  });

  it('honors a custom workspace package pattern', async () => {
    const targets = await discoverWorkbenchTargets(
      repoRoot,
      'workspace',
      'src/workbench.ts',
      undefined,
      'packages/content/src/workbench.ts',
    );

    expect(targets.map((target) => target.packageName)).toEqual([
      '@happyvertical/smrt-content',
    ]);
  });
});
