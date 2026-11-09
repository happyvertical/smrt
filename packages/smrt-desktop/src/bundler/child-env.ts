import { posix, win32 } from 'node:path';
import { NodeDistError } from './node-errors.js';

/**
 * Environment for every child process the bundler spawns (pnpm, the host
 * smoke start). Built from an allowlist: the build host's environment is never
 * forwarded wholesale, so tokens (`NPM_TOKEN`, `NODE_AUTH_TOKEN`,
 * `GITHUB_TOKEN`, cloud credentials), `NODE_OPTIONS`, `NODE_PATH`,
 * `npm_config_*`, `LD_*` and `DYLD_*` never reach a child.
 *
 * Rules:
 * - Only names in `CHILD_ENV_ALLOWLIST` are copied from `base`; matching is
 *   exact on POSIX and case-insensitive on Windows (output uses the canonical
 *   spelling below, keys sorted).
 * - `LC_ALL` and `LANG` are forced to `C`, so child output and sort order do
 *   not depend on the build host's locale. (The design passes `LANG` through;
 *   a fixed locale is more reproducible and no pnpm step needs a UTF-8 one.)
 * - `npm_config_ignore_scripts=true` is forced: even if a stray config would
 *   enable lifecycle scripts, the environment says no. The install argv also
 *   carries `--ignore-scripts` (belt and braces).
 * - `PATH` is reduced to absolute entries. An empty or relative entry means
 *   "the current directory" for execvp/CreateProcess, and the child's cwd is
 *   the staging directory, so a planted `pnpm` there must never be found. If
 *   no absolute entry remains, `PATH` is omitted.
 * - `HOME`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`/`XDG_*` are passed through
 *   when present (pnpm needs its store and config locations). They are plain
 *   locations, not credentials; callers that want isolation pass their own
 *   values in `extra`.
 * - Proxy variables are passed through unchanged so a build behind a proxy
 *   works. They may embed proxy credentials: never log the returned object.
 *
 * `extra` is applied last but may only set allowlisted names plus a small
 * closed set of pnpm location variables, and may not override a forced value;
 * anything else throws `invalid_environment` (a bug in the caller, not input).
 */

/** Canonical spelling of every name copied from the host environment. */
export const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'APPDATA',
  'CI',
  'ComSpec',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LOCALAPPDATA',
  'NO_PROXY',
  'PATH',
  'PATHEXT',
  'PNPM_HOME',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'windir',
];

/** Names only `extra` may add (still no secrets, no code-loading hooks). */
export const CHILD_ENV_EXTRA_ALLOWLIST: readonly string[] = [
  'npm_config_cache',
  'npm_config_registry',
  'npm_config_store_dir',
];

/** Always set; `extra` may not change them. */
export const CHILD_ENV_FORCED: Readonly<Record<string, string>> = Object.freeze(
  {
    LANG: 'C',
    LC_ALL: 'C',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
  },
);

export interface ChildEnvOptions {
  /** Defaults to `process.platform`; selects name matching and PATH rules. */
  readonly platform?: NodeJS.Platform;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE = 32 * 1024;

function validValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_VALUE &&
    !value.includes('\0')
  );
}

/** Keep absolute PATH entries only; `undefined` when none remain. */
export function sanitizePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const windows = platform === 'win32';
  const delimiter = windows ? ';' : ':';
  const isAbs = windows ? win32.isAbsolute : posix.isAbsolute;
  const kept = value
    .split(delimiter)
    .filter((entry) => entry.length > 0 && isAbs(entry));
  return kept.length > 0 ? kept.join(delimiter) : undefined;
}

export function buildChildEnv(
  base: EnvLike,
  extra: EnvLike = {},
  options: ChildEnvOptions = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const canonical = new Map<string, string>();
  for (const name of CHILD_ENV_ALLOWLIST) {
    canonical.set(windows ? name.toLowerCase() : name, name);
  }

  const result = new Map<string, string>();

  // Deterministic choice if the host has both `Path` and `PATH`: sort names.
  for (const key of Object.keys(base).sort()) {
    const name = canonical.get(windows ? key.toLowerCase() : key);
    if (name === undefined || result.has(name)) continue;
    const value = base[key];
    if (validValue(value)) result.set(name, value);
  }

  const extraAllowed = new Set([
    ...CHILD_ENV_ALLOWLIST,
    ...CHILD_ENV_EXTRA_ALLOWLIST,
  ]);
  for (const key of Object.keys(extra).sort()) {
    const value = extra[key];
    if (value === undefined) continue;
    const name =
      [...extraAllowed].find((candidate) =>
        windows
          ? candidate.toLowerCase() === key.toLowerCase()
          : candidate === key,
      ) ?? undefined;
    if (
      !NAME.test(key) ||
      name === undefined ||
      Object.hasOwn(CHILD_ENV_FORCED, name) ||
      !validValue(value)
    ) {
      throw new NodeDistError('invalid_environment');
    }
    result.set(name, value);
  }

  const path = result.get('PATH');
  if (path !== undefined) {
    const clean = sanitizePath(path, platform);
    if (clean === undefined) result.delete('PATH');
    else result.set('PATH', clean);
  }

  for (const [name, value] of Object.entries(CHILD_ENV_FORCED)) {
    result.set(name, value);
  }

  return Object.fromEntries(
    [...result.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
