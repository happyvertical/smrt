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
    '@happyvertical/smrt-ui/data-surface',
    '../smrt-ui/src/components/data/data-surface.ts',
  ],
  [
    '@happyvertical/smrt-ui/feedback',
    '../smrt-ui/src/components/feedback/index.ts',
  ],
  ['@happyvertical/smrt-ui/forms', '../smrt-ui/src/components/forms/index.ts'],
  ['@happyvertical/smrt-ui/i18n', '../smrt-ui/src/i18n/index.ts'],
  ['@happyvertical/smrt-ui/registry', '../smrt-ui/src/registry/index.ts'],
  ['@happyvertical/smrt-ui/themes', '../smrt-ui/src/themes/index.ts'],
  ['@happyvertical/smrt-ui/ui', '../smrt-ui/src/components/ui/index.ts'],
  // Vite treats a string alias as a PREFIX match, so the bare
  // `@happyvertical/smrt-ui` entry above rewrites ANY other subpath under it —
  // `@happyvertical/smrt-ui/utils/import-optional.js` would become
  // `src/index.ts/utils/import-optional.js` and fail to resolve. Every deep
  // subpath a consumer actually imports must therefore be listed explicitly;
  // this is the complete set reached from smrt-svelte's `src/`, which the dev
  // workbench loads through `@happyvertical/smrt-svelte/browser-ai`.
  ['@happyvertical/smrt-ui/data', '../smrt-ui/src/components/data/index.ts'],
  [
    '@happyvertical/smrt-ui/utils/import-optional.js',
    '../smrt-ui/src/utils/import-optional.ts',
  ],
  [
    '@happyvertical/smrt-ui/utils/forms/formatters.js',
    '../smrt-ui/src/utils/forms/formatters.ts',
  ],
  [
    '@happyvertical/smrt-ui/test-support/a11y',
    '../smrt-ui/src/test-support/a11y.ts',
  ],
  // Stylesheet subpaths need entries too — they are under the same bare
  // `@happyvertical/smrt-ui` prefix, so without these the theme CSS the
  // workbench imports would be rewritten into a bogus path under `src/index.ts`
  // and the app would render with NO theme variables at all.
  [
    '@happyvertical/smrt-ui/themes/styles/all.css',
    '../smrt-ui/src/themes/styles/all.css',
  ],
  [
    '@happyvertical/smrt-ui/themes/styles/fonts.css',
    '../smrt-ui/src/themes/styles/fonts.css',
  ],
  // The inference facade is the feature under test here, so it resolves to
  // SOURCE: it is a single dependency-free module, so there is no deep-import
  // hazard, and it keeps the iteration loop free of a rebuild step.
  ['@happyvertical/smrt-web/ai', '../smrt-web/src/ai.ts'],
  // Same reasoning, and it would otherwise disagree with the layer above it:
  // `intents` is reached both from `chat-dev.intents.ts` and from the aliased
  // `smrt-svelte/src/web/view-intent.svelte.ts`, so leaving it on `dist` while
  // its consumer runs from source makes an `intents.ts` edit invisible until
  // smrt-web is rebuilt.
  ['@happyvertical/smrt-web/intents', '../smrt-web/src/intents.ts'],
  // `@happyvertical/smrt-svelte` resolves from SOURCE for the same reason, and
  // is deliberately NOT a declared dependency: smrt-svelte depends on
  // smrt-content, which depends on smrt-chat, so declaring it closes a build
  // cycle (chat -> smrt-svelte -> smrt-content -> chat) and `turbo build` then
  // fails for the whole workspace. Type resolution does not need the
  // declaration — `tsconfig.package-build.json` already maps these specifiers
  // into `packages/smrt-svelte/src/`.
  [
    '@happyvertical/smrt-svelte/browser-ai/svelte',
    '../smrt-svelte/src/browser-ai/svelte/index.ts',
  ],
  [
    '@happyvertical/smrt-svelte/browser-ai',
    '../smrt-svelte/src/browser-ai/index.ts',
  ],
  ['@happyvertical/smrt-svelte', '../smrt-svelte/src/index.ts'],
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
