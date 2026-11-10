import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

// Local QA only: preview unreleased shell defaults without changing package dependencies.
const localPackages = [
  { variable: 'SMRT_CORE_LOCAL', name: '@happyvertical/smrt-core' },
  { variable: 'SMRT_SVELTE_LOCAL', name: '@happyvertical/smrt-svelte' },
  { variable: 'SMRT_UI_LOCAL', name: '@happyvertical/smrt-ui' },
];
const localAliases = localPackages.flatMap(({ variable, name }) => {
  const directory = process.env[variable];
  if (!directory) return [];
  const pkg = JSON.parse(
    readFileSync(resolve(directory, 'package.json'), 'utf8'),
  ) as {
    name: string;
    exports: Record<string, { svelte?: string; import?: string }>;
  };
  if (pkg.name !== name)
    throw new Error(`${variable} must name the ${name} package directory.`);
  return Object.entries(pkg.exports).map(([subpath, entry]) => {
    const specifier = `${name}${subpath === '.' ? '' : subpath.slice(1)}`;
    return {
      find: new RegExp(`^${specifier.replaceAll('.', '\\.')}(?=\\?|$)`),
      replacement: resolve(directory, entry.svelte ?? entry.import ?? ''),
    };
  });
});

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    alias: localAliases,
    dedupe: ['svelte', '@happyvertical/smrt-ui'],
  },
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        realpathSync('node_modules'),
        ...localPackages.flatMap(({ variable }) =>
          process.env[variable]
            ? [resolve(process.env[variable], '../..')]
            : [],
        ),
      ],
    },
    watch: { ignored: ['**/build/**'] },
  },
});
