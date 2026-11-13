/**
 * ACL attestation for the Windows custody rule (W6) through Windows PowerShell.
 *
 * Node cannot read an owner or a DACL on Windows, so the runtime asks the
 * operating system. This is the Windows twin of the macOS `ls -lde` ACL check
 * and follows the same discipline:
 *
 * - the executable is an absolute path under `SystemRoot`, never found on
 *   `PATH`;
 * - the argv is a constant (`-EncodedCommand` of a fixed script) and never
 *   contains a path;
 * - the paths travel in one environment variable, so there is nothing for the
 *   PowerShell parser to interpret, and the script only ever uses
 *   `-LiteralPath` (no wildcard expansion, no `Invoke-Expression`);
 * - the output is one compressed ASCII JSON document that carries no paths;
 * - the call is bounded (timeout, buffer, `shell: false`, hidden window) and
 *   every failure, including a blocked or missing PowerShell, is a refusal:
 *   there is no "unverified" mode.
 *
 * The policy applied to the answer lives in `windows-sddl.ts`.
 */

import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { unsafeFilesystemEntry } from './local-runtime-error.js';
import { validateWindowsPath } from './windows-paths.js';

/** What the inspector reports about one path. */
export interface WindowsAclRecord {
  /** Owner, group and DACL as SDDL. */
  readonly sddl: string;
  /** `FileAttributes` bit set (`0x400` is a reparse point). */
  readonly attributes: number;
  /** File-system name of the volume, for example `NTFS`. */
  readonly driveFormat: string;
  /** `Win32_LogicalDisk.DriveType` (`3` is a local fixed disk). */
  readonly driveType: number;
}

export interface WindowsAclInspection {
  /** SID of the user running this process. */
  readonly userSid: string;
  /** One record per requested path, in request order. */
  readonly records: readonly WindowsAclRecord[];
}

/** Synchronous inspector seam; the default shells out to PowerShell. */
export type WindowsAclInspector = (
  paths: readonly string[],
) => WindowsAclInspection;

/** The one environment variable that carries the paths to the script. */
export const CUSTODY_PATHS_VARIABLE = 'SMRT_CUSTODY_PATHS';

/**
 * The fixed script. Single quotes only (no quoting hazards in a command
 * line), no string-built commands, no `Invoke-Expression`, `-LiteralPath`
 * everywhere. Current user comes from `whoami.exe` by absolute path because
 * `[WindowsIdentity]` is unavailable under Constrained Language Mode.
 */
export const POWERSHELL_INSPECTOR_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  "  $who = & ($env:SystemRoot + '\\System32\\whoami.exe') /user /fo csv /nh",
  "  $sid = ($who -split ',')[-1].Trim([char]34)",
  '  $drives = @{}',
  '  $items = @()',
  `  foreach ($p in ($env:${CUSTODY_PATHS_VARIABLE} -split [char]10)) {`,
  "    if ($p -notmatch '^[A-Za-z]:\\\\') { throw 'path' }",
  '    $letter = $p.Substring(0, 2).ToUpper()',
  '    if (-not $drives.ContainsKey($letter)) {',
  "      $drives[$letter] = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ('DeviceID=''' + $letter + '''')",
  '    }',
  '    $disk = $drives[$letter]',
  '    $item = Get-Item -LiteralPath $p -Force',
  '    $acl = Get-Acl -LiteralPath $p',
  '    $items += [pscustomobject]@{ sddl = [string]$acl.Sddl; attributes = [int]$item.Attributes; driveFormat = [string]$disk.FileSystem; driveType = [int]$disk.DriveType }',
  '  }',
  '  [pscustomobject]@{ user = [string]$sid; items = $items } | ConvertTo-Json -Compress -Depth 4',
  '} catch { exit 1 }',
].join('\n');

/** Constant argv: the script, UTF-16LE base64, never a path. */
export const POWERSHELL_INSPECTOR_ARGV: readonly string[] = Object.freeze([
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-InputFormat',
  'None',
  '-EncodedCommand',
  Buffer.from(POWERSHELL_INSPECTOR_SCRIPT, 'utf16le').toString('base64'),
]);

const INSPECTOR_TIMEOUT_MS = 10_000;
const INSPECTOR_MAX_BUFFER = 256 * 1024;
const MAX_INSPECTED_PATHS = 64;
/** The only inherited variables the inspector needs; never `PATH`. */
const INHERITED_VARIABLES = [
  'SystemRoot',
  'windir',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'ProgramFiles',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
  // Windows PowerShell 5.1 returns nothing from `& whoami.exe` when PATHEXT is
  // absent (observed on Windows 11 26300: empty output, no error), which made
  // the inspector exit 1 for every path. It is a fixed list of extensions.
  'PATHEXT',
] as const;

/** Windows environment names are case-insensitive. */
export function lookupWindowsEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined) return exact;
  const folded = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === folded) return env[key];
  }
  return undefined;
}

function inspectorUnavailable(cause?: unknown): never {
  const error = unsafeFilesystemEntry(
    'Windows custody inspector unavailable: the file access controls could not be verified, so local storage is refused.',
    cause,
  );
  throw error;
}

/** Environment for the child: a fixed allow-list plus the paths. */
export function buildInspectorEnvironment(
  paths: readonly string[],
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  if (paths.length === 0 || paths.length > MAX_INSPECTED_PATHS) {
    return inspectorUnavailable();
  }
  for (const path of paths) {
    // Already W1-clean in every real call; a path that is not is refused here
    // so the line separator can never be forged.
    if (
      typeof path !== 'string' ||
      !/^[A-Za-z]:\\/.test(path) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      /[\u0000-\u001f\u007f]/.test(path)
    ) {
      return inspectorUnavailable();
    }
  }
  const env = buildAllowListedEnvironment(parent);
  env[CUSTODY_PATHS_VARIABLE] = paths.join('\n');
  return env;
}

/**
 * The fixed allow-list of inherited variables (never `PATH`), shared by every
 * child process the Windows custody rule starts.
 */
export function buildAllowListedEnvironment(
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_VARIABLES) {
    const value = lookupWindowsEnvironment(parent, name);
    if (value !== undefined) env[name] = value;
  }
  return env;
}

const SID_TEXT = /^S-1-\d+(?:-\d+){1,15}$/;

/** Validate the inspector's single JSON document. */
export function parseInspectorOutput(
  stdout: string,
  expectedCount: number,
): WindowsAclInspection {
  if (
    stdout.length === 0 ||
    stdout.length > INSPECTOR_MAX_BUFFER ||
    /[^\x20-\x7e\r\n\t]/.test(stdout)
  ) {
    return inspectorUnavailable();
  }
  let document: unknown;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    return inspectorUnavailable(error);
  }
  const root = document as { user?: unknown; items?: unknown } | null;
  if (
    typeof root !== 'object' ||
    root === null ||
    typeof root.user !== 'string' ||
    !SID_TEXT.test(root.user) ||
    !Array.isArray(root.items) ||
    root.items.length !== expectedCount
  ) {
    return inspectorUnavailable();
  }
  const records = root.items.map((entry: unknown): WindowsAclRecord => {
    const item = entry as Record<string, unknown> | null;
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof item.sddl !== 'string' ||
      item.sddl.length === 0 ||
      !Number.isInteger(item.attributes) ||
      (item.attributes as number) < 0 ||
      (item.attributes as number) > 0xffffffff ||
      typeof item.driveFormat !== 'string' ||
      !/^[A-Za-z0-9]{0,16}$/.test(item.driveFormat) ||
      !Number.isInteger(item.driveType)
    ) {
      return inspectorUnavailable();
    }
    return {
      sddl: item.sddl,
      attributes: item.attributes as number,
      driveFormat: item.driveFormat,
      driveType: item.driveType as number,
    };
  });
  return { userSid: root.user, records };
}

/** `execFileSync` shape the inspector depends on (injectable for tests). */
export type InspectorExec = (
  file: string,
  args: readonly string[],
  options: {
    env: Record<string, string>;
    encoding: 'utf8';
    timeout: number;
    maxBuffer: number;
    windowsHide: true;
    shell: false;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => string;

export interface PowerShellInspectorOptions {
  exec?: InspectorExec;
  env?: NodeJS.ProcessEnv;
}

/** Windows PowerShell 5.1 ships with every supported client and server SKU. */
export function powershellExecutable(env: NodeJS.ProcessEnv): string {
  const root = lookupWindowsEnvironment(env, 'SystemRoot');
  if (root === undefined) return inspectorUnavailable();
  let systemRoot: string;
  try {
    systemRoot = validateWindowsPath(root, 'SystemRoot');
  } catch (error) {
    return inspectorUnavailable(error);
  }
  return win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

/** The production inspector. Every failure is a refusal. */
export function createPowerShellAclInspector(
  options: PowerShellInspectorOptions = {},
): WindowsAclInspector {
  const exec: InspectorExec =
    options.exec ??
    ((file, args, execOptions) =>
      execFileSync(file, [...args], execOptions) as unknown as string);
  return (paths) => {
    const parent = options.env ?? process.env;
    const file = powershellExecutable(parent);
    const env = buildInspectorEnvironment(paths, parent);
    let stdout: string;
    try {
      stdout = exec(file, POWERSHELL_INSPECTOR_ARGV, {
        env,
        encoding: 'utf8',
        timeout: INSPECTOR_TIMEOUT_MS,
        maxBuffer: INSPECTOR_MAX_BUFFER,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return inspectorUnavailable(error);
    }
    if (typeof stdout !== 'string') return inspectorUnavailable();
    return parseInspectorOutput(stdout, paths.length);
  };
}
