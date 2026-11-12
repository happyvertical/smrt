/** Test-owned home/state storage, shared by Vitest, Node tests and e2e runners. */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function realTestStateBases(): string[] {
  const homes = new Set([userInfo().homedir, homedir()]);
  return [
    ...[...homes].flatMap((home) => [
      join(home, 'Library', 'Application Support'),
      join(home, '.local', 'state'),
      join(home, 'AppData', 'Local'),
    ]),
    ...[process.env.XDG_STATE_HOME, process.env.LOCALAPPDATA].filter(
      (value): value is string => Boolean(value),
    ),
  ];
}

/** Snapshot every entry name, including non-state files; never remove user data. */
export function guardTestStateBases(bases?: string[]): () => void {
  const directories =
    bases ??
    (process.env.SMRT_TEST_REAL_STATE_BASES
      ? (JSON.parse(process.env.SMRT_TEST_REAL_STATE_BASES) as string[])
      : realTestStateBases());

  const entries = (directory: string): string[] => {
    try {
      return readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const snapshots = new Map(
    [...new Set(directories.map((directory) => resolve(directory)))].map(
      (directory) => [directory, new Set(entries(directory))],
    ),
  );
  return () => {
    for (const [directory, before] of snapshots) {
      const added = entries(directory).filter((entry) => !before.has(entry));
      if (added.length) {
        throw new Error(
          `Tests wrote ${added.length} new entries into the real state base ${directory}: ${added.join(', ')}. Use an isolated test home for every child process.`,
        );
      }
    }
  };
}

/**
 * Install before workers start: even launchers with NODE_ENV=production inherit
 * the isolated OS paths. Keep custody roots outside /tmp (untrusted-parent tests).
 * Teardown restores the caller and removes only the mkdtemp directory we own.
 */
export function installTestHome(): () => void {
  const checkStateBases = guardTestStateBases();
  const parent = fileURLToPath(
    new URL('../node_modules/.cache/test-homes/', import.meta.url),
  );
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(realpathSync(parent), 'home-'));
  const environment = {
    SMRT_TEST_REAL_STATE_BASES:
      process.env.SMRT_TEST_REAL_STATE_BASES ??
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
  const original = Object.fromEntries(
    Object.keys(environment).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, environment);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener('exit', onExit);
    try {
      checkStateBases();
    } catch (error) {
      // Vite logs global-teardown errors without failing Vitest's CLI.
      // Preserve a failing exit status as well as the diagnostic.
      process.exitCode = 1;
      throw error;
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(home, { recursive: true, force: true });
    }
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
