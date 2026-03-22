import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep package-local development pointed at sibling workspace sources so this
// reference package works without requiring those packages to be prebuilt.
const workspaceAliasEntries = [
  ['@happyvertical/smrt-assets', '../assets/src/index.ts'],
  ['@happyvertical/smrt-chat', '../chat/src/index.ts'],
  ['@happyvertical/smrt-chat/svelte', '../chat/src/svelte/index.ts'],
  ['@happyvertical/smrt-config', '../config/src/index.ts'],
  ['@happyvertical/smrt-core/scanner', '../core/src/scanner/index.ts'],
  ['@happyvertical/smrt-core/schema/utils', '../core/src/schema/utils.ts'],
  ['@happyvertical/smrt-core', '../core/src/index.ts'],
  ['@happyvertical/smrt-facts', '../facts/src/index.ts'],
  ['@happyvertical/smrt-images', '../images/src/index.ts'],
  ['@happyvertical/smrt-images/svelte', '../images/src/svelte/index.ts'],
  ['@happyvertical/smrt-messages', '../messages/src/index.ts'],
  ['@happyvertical/smrt-playground', '../smrt-playground/src/index.ts'],
  [
    '@happyvertical/smrt-playground/svelte',
    '../smrt-playground/src/svelte/index.ts',
  ],
  ['@happyvertical/smrt-scanner', '../scanner/src/index.ts'],
  ['@happyvertical/smrt-profiles', '../profiles/src/index.ts'],
  ['@happyvertical/smrt-secrets', '../secrets/src/index.ts'],
  ['@happyvertical/smrt-tags', '../tags/src/index.ts'],
  ['@happyvertical/smrt-tenancy', '../tenancy/src/index.ts'],
  [
    '@happyvertical/smrt-svelte/layout',
    '../smrt-svelte/src/components/layout/index.ts',
  ],
  [
    '@happyvertical/smrt-svelte/ui',
    '../smrt-svelte/src/components/ui/index.ts',
  ],
  [
    '@happyvertical/smrt-svelte/registry',
    '../smrt-svelte/src/registry/index.ts',
  ],
  [
    '@happyvertical/smrt-svelte/themes',
    '../smrt-svelte/src/themes/index.ts',
  ],
];

function getSortedWorkspaceAliasEntries() {
  return [...workspaceAliasEntries].sort(
    ([left], [right]) => right.length - left.length,
  );
}

function resolveWorkspacePackageRoot(relativePath) {
  const absolutePath = resolve(__dirname, relativePath);
  const srcSegment = `${sep}src${sep}`;
  const srcIndex = absolutePath.lastIndexOf(srcSegment);

  if (srcIndex >= 0) {
    return absolutePath.slice(0, srcIndex);
  }

  return dirname(absolutePath);
}

export const workspaceAliasPackageNames = workspaceAliasEntries.map(
  ([packageName]) => packageName,
);

export const workspacePackageRoots = Object.fromEntries(
  workspaceAliasEntries
    .filter(([packageName]) => packageName.split('/').length === 2)
    .map(([packageName, relativePath]) => [
      packageName,
      resolveWorkspacePackageRoot(relativePath),
    ]),
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
