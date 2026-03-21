import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep package-local development pointed at sibling workspace sources so this
// reference package works without requiring those packages to be prebuilt.
const workspaceAliasEntries = [
  ['@happyvertical/smrt-assets', '../assets/src/index.ts'],
  ['@happyvertical/smrt-chat', '../chat/src/index.ts'],
  ['@happyvertical/smrt-chat/svelte', '../chat/src/svelte/index.ts'],
  ['@happyvertical/smrt-facts', '../facts/src/index.ts'],
  ['@happyvertical/smrt-images', '../images/src/index.ts'],
  ['@happyvertical/smrt-images/svelte', '../images/src/svelte/index.ts'],
  ['@happyvertical/smrt-messages', '../messages/src/index.ts'],
  ['@happyvertical/smrt-playground', '../smrt-playground/src/index.ts'],
  [
    '@happyvertical/smrt-playground/svelte',
    '../smrt-playground/src/svelte/index.ts',
  ],
  ['@happyvertical/smrt-profiles', '../profiles/src/index.ts'],
  ['@happyvertical/smrt-secrets', '../secrets/src/index.ts'],
  ['@happyvertical/smrt-tags', '../tags/src/index.ts'],
  ['@happyvertical/smrt-tenancy', '../tenancy/src/index.ts'],
  [
    '@happyvertical/smrt-svelte/registry',
    '../smrt-svelte/src/registry/index.ts',
  ],
  [
    '@happyvertical/smrt-svelte/themes',
    '../smrt-svelte/src/themes/index.ts',
  ],
];

export const svelteKitWorkspaceAliases = Object.fromEntries(
  workspaceAliasEntries,
);

export const viteWorkspaceAliases = Object.fromEntries(
  workspaceAliasEntries.map(([packageName, relativePath]) => [
    packageName,
    resolve(__dirname, relativePath),
  ]),
);
