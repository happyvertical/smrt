import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { smrtWorkbenchVitePlugin } from '../src/vite.js';

const defaultProjectRoot = resolve(__dirname, '../../..');
const projectRoot = resolve(
  process.env.SMRT_WORKBENCH_PROJECT_ROOT || defaultProjectRoot,
);
const workbenchCwd = resolve(process.env.SMRT_WORKBENCH_CWD || projectRoot);
const allowRemoteHost = process.env.SMRT_WORKBENCH_ALLOW_REMOTE === '1';
const sourceWorkspaceRoot = existsSync(
  join(projectRoot, 'packages', 'smrt-workbench', 'host', 'package.json'),
)
  ? projectRoot
  : null;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLoopbackHost(host: string | boolean | undefined) {
  if (host === undefined || host === false) {
    return true;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

function createWorkspacePackageAliases(workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return [];
  }

  const packagesDir = resolve(workspaceRoot, 'packages');
  const aliases: { find: RegExp; replacement: string }[] = [];

  for (const packageDirName of readdirSync(packagesDir)) {
    const packageDir = join(packagesDir, packageDirName);
    const packageJsonPath = join(packageDir, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const packageName = packageJson.name;
    if (
      typeof packageName !== 'string' ||
      !packageName.startsWith('@happyvertical/smrt-')
    ) {
      continue;
    }

    const srcIndexPath = join(packageDir, 'src', 'index.ts');
    if (existsSync(srcIndexPath)) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(packageName)}$`),
        replacement: srcIndexPath,
      });
    }

    const svelteIndexPath = join(packageDir, 'src', 'svelte', 'index.ts');
    if (existsSync(svelteIndexPath)) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(packageName)}/svelte$`),
        replacement: svelteIndexPath,
      });
    }

    const viteIndexPath = join(packageDir, 'src', 'vite.ts');
    if (existsSync(viteIndexPath)) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(packageName)}/vite$`),
        replacement: viteIndexPath,
      });
    }

    const runtimeIndexPath = join(packageDir, 'src', 'runtime.ts');
    if (existsSync(runtimeIndexPath)) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(packageName)}/runtime$`),
        replacement: runtimeIndexPath,
      });
    }
  }

  return aliases.sort(
    (left, right) => right.find.source.length - left.find.source.length,
  );
}

const workspacePackageAliases =
  createWorkspacePackageAliases(sourceWorkspaceRoot);
const sourceAliases = sourceWorkspaceRoot
  ? [
      {
        find: /^@happyvertical\/smrt-ui\/themes\/styles\/(.*)$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/themes/styles/$1',
        ),
      },
      {
        find: /^@happyvertical\/smrt-ui\/themes$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/themes/index.ts',
        ),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/workspace$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-svelte/src/components/workspace/index.ts',
        ),
      },
      {
        find: /^@happyvertical\/smrt-ui\/layout$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/components/layout/index.ts',
        ),
      },
      {
        find: /^@happyvertical\/smrt-ui\/ui$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/components/ui/index.ts',
        ),
      },
      {
        find: /^@happyvertical\/smrt-ui\/registry$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/registry/index.ts',
        ),
      },
      {
        find: /^@happyvertical\/smrt-ui\/i18n$/,
        replacement: resolve(
          sourceWorkspaceRoot,
          'packages/smrt-ui/src/i18n/index.ts',
        ),
      },
    ]
  : [];

export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  resolve: {
    alias: [...workspacePackageAliases, ...sourceAliases],
  },
  plugins: [
    {
      name: 'smrt-workbench-loopback-guard',
      configResolved(config) {
        if (!isLoopbackHost(config.server.host) && !allowRemoteHost) {
          throw new Error(
            'Refusing to expose the workbench on a non-loopback host. Use the SMRT CLI with --allow-remote only on a trusted network.',
          );
        }
      },
    },
    smrtWorkbenchVitePlugin({
      cwd: workbenchCwd,
      mode: 'auto',
      projectRoot,
      workspaceRoot: sourceWorkspaceRoot || undefined,
    }),
    sveltekit(),
  ],
  server: {
    fs: {
      allow: [projectRoot, resolve(__dirname, '..')],
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.smrt/**',
        '**/*.db',
        '**/*.db-{journal,shm,wal}',
        '**/*.duckdb*',
        '**/*.sqlite*',
      ],
    },
    port: 5570,
  },
});
