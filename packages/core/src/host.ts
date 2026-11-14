/**
 * Node host services (#2838).
 *
 * The modules that need a Node-only dependency reach it through this file so
 * the browser build can swap it: `package.json#browser` maps
 * `./dist/host.js` to `./dist/host.browser.js`, which exposes the same names
 * without importing `pg`, the `@happyvertical/sql` root, the AI SDK's CLI
 * providers, or the filesystem-backed package discovery. Node consumers and
 * every test resolve this file, so their behaviour is unchanged. A new
 * export here needs a counterpart in `host.browser.ts` (it is typechecked
 * against this module).
 */

export {
  buildWhere,
  NestedTransactionError,
  raw,
} from '@happyvertical/sql/query';

/** Load SQL adapters only when opening a database, not when importing a model. */
export const getDatabase: typeof import('@happyvertical/sql').getDatabase =
  async (options) => {
    const sql = await import('@happyvertical/sql');
    return sql.getDatabase(options);
  };

/** The AI SDK, loaded on first use to keep it off the cold-start path (#2894). */
export function importAI(): Promise<typeof import('@happyvertical/ai')> {
  return import('@happyvertical/ai');
}

/** Names of the installed SMRT packages whose manifest declares `moduleType: "smrt"`. */
export async function discoverInstalledSmrtPackages(): Promise<string[]> {
  const discoverSpecifier = import.meta.url.endsWith('.ts')
    ? './manifest/discover-smrt-packages.ts'
    : './manifest/discover-smrt-packages.js';

  const { discoverSmrtPackages } = await import(discoverSpecifier);
  return discoverSmrtPackages();
}
