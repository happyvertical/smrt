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
      expect(scope.packageManager).toBe('npm');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { packageManager: 'pnpm', marker: 'pnpm-lock.yaml' },
    { packageManager: 'yarn', marker: 'yarn.lock' },
  ] as const)('detects $packageManager consumers from their lockfile', ({
    packageManager,
    marker,
  }) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-'));
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'consumer-app' }),
    );
    writeFileSync(join(projectRoot, marker), '');

    try {
      expect(resolveWorkbenchScope(projectRoot).packageManager).toBe(
        packageManager,
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'pnpm',
    'yarn',
    'npm',
  ] as const)('detects %s consumers from packageManager metadata', (packageManager) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-'));
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'consumer-app',
        packageManager: `${packageManager}@1.0.0`,
      }),
    );

    try {
      expect(resolveWorkbenchScope(projectRoot).packageManager).toBe(
        packageManager,
      );
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
      ),
    ).toEqual(
      expect.objectContaining({
        sourcePath: expect.stringContaining('packages/content/src/content.ts'),
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'body', type: 'text' }),
        ]),
      }),
    );
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
    expect(project.packages[0]?.api.restEndpoints).not.toContainEqual(
      expect.objectContaining({
        objectName: 'ContentContributions',
        action: 'list',
      }),
    );
    expect(project.packages[0]?.api.restEndpoints).toContainEqual(
      expect.objectContaining({
        objectName: 'ContentContributions',
        action: 'submitWebContribution',
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
    const customTool = project.packages[0]?.api.mcpTools.find(
      (tool) => tool.action === 'listForContribution',
    );
    expect(customTool?.parameters).toEqual([
      expect.objectContaining({ name: 'id', required: true }),
      expect.objectContaining({ name: 'options', required: false }),
    ]);
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

  it('retains a focused consumer app workbench module', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-'));
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'consumer-app' }),
    );
    writeFileSync(
      join(projectRoot, 'src', 'workbench.ts'),
      'export default {};',
    );

    try {
      const targets = await discoverWorkbenchTargets(
        projectRoot,
        'consumer',
        'src/workbench.ts',
        'consumer-app',
      );

      expect(targets).toEqual([
        expect.objectContaining({
          packageName: 'consumer-app',
          source: 'app',
          sourcePath: join(projectRoot, 'src', 'workbench.ts'),
        }),
      ]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
