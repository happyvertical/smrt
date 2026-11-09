import { homedir } from 'node:os';
import { DesktopContractError } from '../errors.js';
import {
  type AbsolutePath,
  appendSegments,
  flavorOf,
  formatAbsolutePath,
  parseAbsolutePath,
  separatorOf,
} from '../internal/abs-path.js';
import { isBundleId } from '../internal/grammar.js';

/** Name of the private state directory inside `app_local_data_dir`. */
export const DESKTOP_SHELL_DIRNAME = '.desktop-shell';

export interface LocationOptions {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Home directory. Defaults to `HOME` / `USERPROFILE`, then `os.homedir()`. */
  readonly home?: string;
}

function stripTrailingSeparators(value: string, separator: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === separator) end--;
  // Keep the root of a drive (`C:\`).
  return /^[A-Za-z]:$/.test(value.slice(0, end))
    ? value.slice(0, end + 1)
    : value.slice(0, end);
}

function absolute(
  value: string | undefined,
  platform: NodeJS.Platform,
): AbsolutePath {
  const flavor = flavorOf(platform);
  const parsed =
    value === undefined
      ? null
      : parseAbsolutePath(
          stripTrailingSeparators(value, separatorOf(flavor)),
          flavor,
        );
  if (parsed === null) throw new DesktopContractError('invalid_environment');
  return parsed;
}

/**
 * `app_local_data_dir(bundleId)` exactly as Tauri computes it:
 * macOS `~/Library/Application Support/<bundleId>`, Windows
 * `%LOCALAPPDATA%\<bundleId>`, Linux `${XDG_DATA_HOME:-~/.local/share}/<bundleId>`.
 *
 * Windows deliberately uses the machine-local `LOCALAPPDATA`, never the
 * roaming `APPDATA`: pid, socket and install paths must not follow a user to
 * another machine. Throws `invalid_field` for a bad `bundleId`,
 * `unsupported_platform`, or `invalid_environment` when a needed variable is
 * missing or not an absolute path.
 */
export function resolveAppLocalDataDir(
  bundleId: string,
  options: LocationOptions = {},
): string {
  if (!isBundleId(bundleId)) {
    throw new DesktopContractError('invalid_field', { field: 'bundleId' });
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  let base: AbsolutePath;
  if (platform === 'win32') {
    base = absolute(env.LOCALAPPDATA, platform);
  } else if (platform === 'darwin' || platform === 'linux') {
    const home = absolute(options.home ?? env.HOME ?? homedir(), platform);
    if (platform === 'darwin') {
      base = appendSegments(home, ['Library', 'Application Support']);
    } else {
      // The XDG spec says to ignore a relative `XDG_DATA_HOME`.
      const xdg = env.XDG_DATA_HOME;
      const xdgBase =
        xdg === undefined || xdg === ''
          ? null
          : parseAbsolutePath(stripTrailingSeparators(xdg, '/'), 'posix');
      base = xdgBase ?? appendSegments(home, ['.local', 'share']);
    }
  } else {
    throw new DesktopContractError('unsupported_platform');
  }
  return formatAbsolutePath(appendSegments(base, [bundleId]));
}

/**
 * The private state directory, `<app_local_data_dir>/.desktop-shell`
 * (mode 0700, created by the shell). Same options and errors as
 * `resolveAppLocalDataDir`.
 */
export function resolveDesktopShellDir(
  bundleId: string,
  options: LocationOptions = {},
): string {
  const platform = options.platform ?? process.platform;
  const flavor = flavorOf(platform);
  const local = parseAbsolutePath(
    resolveAppLocalDataDir(bundleId, options),
    flavor,
  ) as AbsolutePath;
  return formatAbsolutePath(appendSegments(local, [DESKTOP_SHELL_DIRNAME]));
}
