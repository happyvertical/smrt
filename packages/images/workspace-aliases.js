import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const workspaceAliasEntries = [
  ['@happyvertical/smrt-assets', '../assets/src/index.ts'],
  ['@happyvertical/smrt-core', '../core/src/index.ts'],
  ['@happyvertical/smrt-tags', '../tags/src/index.ts'],
  ['@happyvertical/smrt-tenancy', '../tenancy/src/index.ts'],
  ['@happyvertical/smrt-playground', '../smrt-playground/src/index.ts'],
  [
    '@happyvertical/smrt-playground/svelte',
    '../smrt-playground/src/svelte/index.ts',
  ],
  ['@happyvertical/smrt-svelte/themes', '../smrt-svelte/src/themes/index.ts'],
];

function getSortedWorkspaceAliasEntries() {
  return [...workspaceAliasEntries].sort(
    ([left], [right]) => right.length - left.length,
  );
}

export const workspaceAliasPackageNames = workspaceAliasEntries.map(
  ([packageName]) => packageName,
);

export const svelteKitWorkspaceAliases = Object.fromEntries(
  getSortedWorkspaceAliasEntries(),
);

export const viteWorkspaceAliases = getSortedWorkspaceAliasEntries().map(
  ([packageName, relativePath]) => ({
    find: packageName,
    replacement: resolve(__dirname, relativePath),
  }),
);
