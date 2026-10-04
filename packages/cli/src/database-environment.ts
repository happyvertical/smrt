/**
 * `DATABASE_URL` / `DATABASE_TYPE` as the CLI's database fallback (#3410).
 *
 * Every `smrt db:*` command reads `packages.cli.database` from smrt-config.
 * `smrt app setup` / `smrt app migrate` hand a child `smrt db:migrate` the
 * profile-owned database through the environment, so an application had to
 * forward those variables in its own config. This module closes that gap
 * once, before any command runs, with an explicit precedence:
 *
 * 1. `packages.cli.database.url` from any config layer (runtime `setConfig`,
 *    `smrt.config` `packages.cli`, or the global `smrt` section) — an explicit
 *    project setting always wins, so a stray shell `DATABASE_URL` can never
 *    retarget a project that names its database.
 * 2. `DATABASE_URL`, with the engine from the config's `database.type`, else
 *    `DATABASE_TYPE` (`sqlite`, `postgres`, `postgresql`), else inferred from
 *    the URL scheme (`postgres://`/`postgresql://` → postgres, anything else
 *    sqlite — the same default the commands apply to a typeless config).
 * 3. The built-in default (`:memory:`), which the schema commands refuse.
 *
 * The rule lives in smrt-config (`resolveCliDatabaseConfig`) so `smrt-dev-mcp`
 * resolves the same database (#3446); this module applies it to the CLI.
 *
 * URL and engine travel as a pair: a configured URL never combines with an
 * environment engine. An unrecognised `DATABASE_TYPE` disables the fallback
 * (with a warning that names the variable, never its URL) rather than guess.
 */

import type {
  CliDatabaseSource,
  CliDatabaseType as ConfigCliDatabaseType,
} from '@happyvertical/smrt-config';

/** Database engines the CLI's `packages.cli.database.type` accepts. */
export type CliDatabaseType = ConfigCliDatabaseType;

/** Where {@link applyDatabaseEnvironment} found the effective database. */
export type DatabaseConfigSource = CliDatabaseSource;

/**
 * Apply `DATABASE_URL`/`DATABASE_TYPE` as the CLI database when no config
 * layer declares `packages.cli.database.url`. Call after `loadConfig()`.
 * The precedence itself is smrt-config's `resolveCliDatabaseConfig()`, which
 * `smrt-dev-mcp` shares (#3446).
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @param warn - Sink for the one-line invalid-type warning.
 * @returns Which source supplies the effective database.
 */
export async function applyDatabaseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) =>
    void process.stderr.write(`${message}\n`),
): Promise<DatabaseConfigSource> {
  const { resolveCliDatabaseConfig, setConfig } = await import(
    '@happyvertical/smrt-config'
  );
  const resolved = resolveCliDatabaseConfig(env);
  if (resolved.source === 'invalid-environment') {
    warn(
      `⚠️  Ignoring DATABASE_URL: ${resolved.error} Configure packages.cli.database in smrt.config instead.`,
    );
  } else if (resolved.source === 'environment' && resolved.database) {
    setConfig({ packages: { cli: { database: resolved.database } } });
  }
  return resolved.source;
}
