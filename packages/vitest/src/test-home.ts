/** Test-owned home/state storage, shared by Vitest, Node tests and e2e runners. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function realTestStateBases(): string[] {
  const homes = new Set([userInfo().homedir, homedir()]);
  return [
    ...[...homes].flatMap((home) => [
      join(home, 'Library', 'Application Support'),
      join(home, '.local', 'state'),
      join(home, '.local', 'share'),
      join(home, 'AppData', 'Local'),
    ]),
    ...[
      process.env.XDG_STATE_HOME,
      process.env.XDG_DATA_HOME,
      process.env.LOCALAPPDATA,
    ].filter((value): value is string => Boolean(value)),
  ];
}

/** Copy only test isolation settings into a deliberately restricted child env. */
export function testHomeEnvironment(): Record<string, string> {
  return Object.fromEntries(
    [
      'SMRT_FORBIDDEN_STATE_BASES',
      'PLAYWRIGHT_BROWSERS_PATH',
      'HOME',
      'USERPROFILE',
      'XDG_STATE_HOME',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'APPDATA',
      'LOCALAPPDATA',
    ].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  );
}

/**
 * Install before workers start: even launchers with NODE_ENV=production inherit
 * the isolated OS paths. POSIX custody fixtures stay outside untrusted /tmp;
 * Windows uses a shallow OS temp profile to preserve the runtime path budget.
 * Teardown restores the caller and removes only the mkdtemp directory we own.
 */
export function installTestHome(): () => void {
  const parent =
    process.platform === 'win32'
      ? tmpdir()
      : fileURLToPath(
          new URL('../node_modules/.cache/test-homes/', import.meta.url),
        );
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(realpathSync(parent), 'home-'));
  const environment = {
    // Browser binaries are installed prerequisites, separate from writable app state.
    // Resolve their cache before HOME/XDG isolation so Playwright workers can launch.
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      join(
        process.platform === 'darwin'
          ? join(homedir(), 'Library', 'Caches')
          : process.platform === 'win32'
            ? (process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
            : (process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache')),
        'ms-playwright',
      ),
    SMRT_FORBIDDEN_STATE_BASES:
      process.env.SMRT_FORBIDDEN_STATE_BASES ??
      JSON.stringify(realTestStateBases()),
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
  };
  // SHGetKnownFolderPath verifies profile-relative AppData paths before Tauri
  // can create its app directory. Create only bases owned by this new home.
  for (const directory of [environment.LOCALAPPDATA, environment.APPDATA]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const original = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener('exit', onExit);
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
  const onExit = () => {
    try {
      dispose();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once('exit', onExit);
  return dispose;
}
