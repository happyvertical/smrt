import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { smrtPlaygroundVitePlugin } from '@happyvertical/smrt-playground/vite';

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createWorkspacePackageAliases() {
  const packagesDir = resolve(__dirname, '../..');
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
  }

  return aliases.sort(
    (left, right) => right.find.source.length - left.find.source.length,
  );
}

const workspacePackageAliases = createWorkspacePackageAliases();

export default defineConfig({
  esbuild: {
    // Workspace playground modules should not depend on each child package's
    // local `.svelte-kit` state just to transpile TypeScript metadata files.
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    }),
  },
  resolve: {
    alias: [
      ...workspacePackageAliases,
      {
        find: /^@happyvertical\/smrt-playground\/svelte$/,
        replacement: resolve(__dirname, '../src/svelte/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-playground\/vite$/,
        replacement: resolve(__dirname, '../src/vite.ts'),
      },
      {
        find: /^@happyvertical\/smrt-playground$/,
        replacement: resolve(__dirname, '../src/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/themes$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/themes/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/layout$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/components/layout/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/ui$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/components/ui/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/registry$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/registry/index.ts'),
      },
    ],
  },
  plugins: [smrtPlaygroundVitePlugin({ mode: 'workspace' }), sveltekit()],
  server: {
    port: 5560,
  },
});
