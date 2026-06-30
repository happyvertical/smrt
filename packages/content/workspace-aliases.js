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
  // @happyvertical/smrt-core is deliberately NOT aliased to source. If it were,
  // svelte-check would pull core/src into the program while transitive
  // node_modules `.d.ts` (e.g. @happyvertical/smrt-prompts) still resolve core
  // to core/dist — two module identities at once. core's `declare global`
  // manifest-cache augmentations (#543) are typed with core's own
  // SmartObjectManifest, so the src + dist `declare global` blocks collide
  // ("Subsequent variable declarations must have the same type") and fail the
  // typecheck gate. Letting core resolve to its published dist types uniformly
  // — exactly what the `tsc -p tsconfig.typecheck.json` step already does and
  // passes — keeps it single-identity; skipLibCheck then covers core's .d.ts.
  // See #1536. (core is always built before content typechecks: turbo
  // `typecheck` dependsOn `^build`.)
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
    '@happyvertical/smrt-ui/i18n',
    '../smrt-ui/src/i18n/index.ts',
  ],
  [
    '@happyvertical/smrt-ui/layout',
    '../smrt-ui/src/components/layout/index.ts',
  ],
  [
    '@happyvertical/smrt-ui/ui',
    '../smrt-ui/src/components/ui/index.ts',
  ],
  [
    '@happyvertical/smrt-ui/registry',
    '../smrt-ui/src/registry/index.ts',
  ],
  [
    '@happyvertical/smrt-ui/themes',
    '../smrt-ui/src/themes/index.ts',
  ],
  ['@happyvertical/smrt-types', '../types/src/index.ts'],
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
