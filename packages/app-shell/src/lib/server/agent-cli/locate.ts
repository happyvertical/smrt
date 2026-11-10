// Find a CLI on this machine. A desktop app started from Finder or the Start
// menu has a minimal PATH, so after PATH come the usual install places, and
// last the person's login shell (`command -v`). Nothing is installed and no
// file other than the executable itself is read.
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { childEnv } from './env.ts';
import { runCollect } from './runner.ts';
import type { AgentTool } from './tools.ts';
import { AGENT_TOOL_INFO } from './tools.ts';

export interface LocateDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  home: string;
  /** Ask the login shell (POSIX only). Tests turn it off. */
  loginShell: boolean;
  /** System-wide install directories to check. Default: the usual ones. */
  systemDirs?: readonly string[];
}

export function defaultLocateDeps(): LocateDeps {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    loginShell: true,
  };
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(path, e.name));
  } catch {
    return [];
  }
}

/** Directories the CLIs usually install into, most likely first. */
export function candidateDirs(
  deps: Pick<LocateDeps, 'env' | 'platform' | 'home' | 'systemDirs'>,
): string[] {
  const { env, platform, home } = deps;
  const out: string[] = [];
  const add = (...dirs: (string | undefined)[]) => {
    for (const d of dirs) if (d) out.push(d);
  };
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    add(
      join(home, '.local', 'bin'),
      join(appData, 'npm'),
      join(local, 'Programs', 'claude'),
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(local, 'pnpm'),
      env.PNPM_HOME,
      env.NPM_CONFIG_PREFIX,
    );
    return [...new Set(out)];
  }
  add(
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.claude', 'bin'),
    ...(deps.systemDirs ?? ['/opt/homebrew/bin', '/usr/local/bin']),
    join(home, '.npm-global', 'bin'),
    env.NPM_CONFIG_PREFIX ? join(env.NPM_CONFIG_PREFIX, 'bin') : undefined,
    env.PNPM_HOME,
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    ...(deps.systemDirs ? [] : ['/snap/bin', '/usr/bin']),
  );
  for (const v of listDirs(join(home, '.nvm', 'versions', 'node'))
    .sort()
    .reverse())
    add(join(v, 'bin'));
  for (const v of listDirs(join(home, '.fnm', 'node-versions'))
    .sort()
    .reverse())
    add(join(v, 'installation', 'bin'));
  return [...new Set(out)];
}

function names(binary: string, platform: NodeJS.Platform): string[] {
  // Windows: only a real executable can be started without a shell.
  return platform === 'win32' ? [`${binary}.exe`] : [binary];
}

function findIn(
  dirs: readonly string[],
  binary: string,
  platform: NodeJS.Platform,
): string | null {
  for (const dir of dirs) {
    for (const name of names(binary, platform)) {
      const path = join(dir, name);
      if (isExecutable(path, platform)) return path;
    }
  }
  return null;
}

async function viaLoginShell(
  binary: string,
  deps: LocateDeps,
): Promise<string | null> {
  const shell = deps.env.SHELL;
  if (!deps.loginShell || deps.platform === 'win32' || !shell?.startsWith('/'))
    return null;
  // Both are fixed strings built here; the binary name is from our table.
  for (const flags of [['-lc'], ['-ilc']]) {
    const result = await runCollect({
      command: shell,
      args: [...flags, `printf '__SMRT_BIN__%s\\n' "$(command -v ${binary})"`],
      env: childEnv(deps.env),
      timeoutMs: 5_000,
    });
    const line = result.stdout
      .split('\n')
      .reverse()
      .find((l) => l.startsWith('__SMRT_BIN__'));
    const path = line?.slice('__SMRT_BIN__'.length).trim();
    if (path?.startsWith('/') && isExecutable(path, deps.platform)) return path;
  }
  return null;
}

/** Absolute path of the tool's executable, or null when it is not installed. */
export async function locateBinary(
  tool: AgentTool,
  deps: LocateDeps = defaultLocateDeps(),
): Promise<string | null> {
  const { binary } = AGENT_TOOL_INFO[tool];
  const pathVar = deps.env.PATH ?? deps.env.Path ?? deps.env.path ?? '';
  return (
    findIn(pathVar.split(delimiter).filter(Boolean), binary, deps.platform) ??
    findIn(candidateDirs(deps), binary, deps.platform) ??
    (await viaLoginShell(binary, deps))
  );
}
