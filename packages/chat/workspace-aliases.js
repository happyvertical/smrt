import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const workspaceAliasEntries = [
  ['@happyvertical/smrt-chat', './src/index.ts'],
  ['@happyvertical/smrt-chat/svelte', './src/svelte/index.ts'],
  ['@happyvertical/smrt-playground', '../smrt-playground/src/index.ts'],
  [
    '@happyvertical/smrt-playground/svelte',
    '../smrt-playground/src/svelte/index.ts',
  ],
  ['@happyvertical/smrt-ui', '../smrt-ui/src/index.ts'],
  ['@happyvertical/smrt-ui/chat', '../smrt-ui/src/components/chat/index.ts'],
  [
    '@happyvertical/smrt-ui/feedback',
    '../smrt-ui/src/components/feedback/index.ts',
  ],
  ['@happyvertical/smrt-ui/forms', '../smrt-ui/src/components/forms/index.ts'],
  ['@happyvertical/smrt-ui/i18n', '../smrt-ui/src/i18n/index.ts'],
  ['@happyvertical/smrt-ui/registry', '../smrt-ui/src/registry/index.ts'],
  ['@happyvertical/smrt-ui/themes', '../smrt-ui/src/themes/index.ts'],
  ['@happyvertical/smrt-ui/ui', '../smrt-ui/src/components/ui/index.ts'],
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
