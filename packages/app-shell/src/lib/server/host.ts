// Process-wide holders: where the shell gets its database, its data root and
// the one `AppHost` (the user app's runtime). Everything server-side reaches
// them through here, so tests can configure a temp directory and a SQLite
// database without SvelteKit.
//
// Data layout: the host's `dataDir` is `<data root>/user-app`, a plain
// directory inside the app-runtime data root, so the encrypted backup that
// seals the root also seals app.db, snapshots and archives. No symlinks.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import { AppHost } from '../../engine/index.ts';
import { publish } from './events.ts';
import { ShellVersionStore } from './version-store.ts';

export interface ShellContext {
  /** The shell's database (shell.db: users, App, AppVersion, Approval). */
  db: () => Promise<DatabaseInterface>;
  /** The app-runtime data root. */
  dataRoot: () => Promise<string>;
  /**
   * The runtime's secrets master key (created once on the local profile and
   * kept in its vault key store; `SMRT_SECRET_MASTER_KEY` always wins). Never
   * logged or sent anywhere.
   */
  secretMasterKey?: () => Promise<string | null>;
  /** Override the app worker entry (tests; defaults to the engine's own). */
  workerUrl?: URL | string;
}

let context: ShellContext | null = null;
let syncDb: DatabaseInterface | null = null;
let hostPromise: Promise<AppHost> | null = null;
let hostRef: AppHost | null = null;
let shutdownHooked = false;

export function configureShell(next: ShellContext): void {
  context = next;
}

function requireContext(): ShellContext {
  if (!context)
    throw new Error('the shell is not configured (call configureShell first)');
  return context;
}

export async function getShellDb(): Promise<DatabaseInterface> {
  const db = await requireContext().db();
  syncDb = db;
  return db;
}

/** The runtime's secrets master key, or null when it supplies none. */
export async function getShellSecretMasterKey(): Promise<string | null> {
  const provide = requireContext().secretMasterKey;
  return provide ? provide() : null;
}

/** The shell database once `getShellDb()` has resolved. For sync thunks. */
export function shellDbSync(): DatabaseInterface {
  if (!syncDb) throw new Error('the shell database is not open yet');
  return syncDb;
}

export function dataRoot(): Promise<string> {
  return requireContext().dataRoot();
}

function workerUrl(): URL | string {
  const configured = requireContext().workerUrl;
  if (configured) return configured;
  // From source (dev, tests) the worker sits next to the engine; from a build
  // it is the package's published engine worker.
  const local = new URL('../../engine/app-worker.ts', import.meta.url);
  if (existsSync(fileURLToPath(local))) return local;
  return new URL(
    import.meta.resolve('@happyvertical/smrt-app-shell/engine/worker'),
  );
}

/** The one AppHost, opened on first use. */
export function getHost(): Promise<AppHost> {
  hostPromise ??= (async () => {
    const db = await getShellDb();
    const dir = join(await dataRoot(), 'user-app');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const host = await AppHost.open(dir, {
      store: new ShellVersionStore(db),
      workerUrl: workerUrl(),
    });
    host.on('changed', (e: { version: number; summary: string }) =>
      publish({ type: 'changed', version: e.version, summary: e.summary }),
    );
    host.on('records', (e: { model: string | null }) =>
      publish({ type: 'records', model: e.model }),
    );
    hostRef = host;
    if (!shutdownHooked) {
      shutdownHooked = true;
      // adapter-node emits this on SIGTERM/SIGINT before exiting.
      process.on('sveltekit:shutdown' as never, () => {
        void closeHost();
      });
    }
    return host;
  })();
  hostPromise.catch(() => {
    hostPromise = null; // let the next call retry
  });
  return hostPromise;
}

/** The host if it is already open (sync, for list_changed wiring). */
export function openHost(): AppHost | null {
  return hostRef;
}

export async function closeHost(): Promise<void> {
  const pending = hostPromise;
  hostPromise = null;
  hostRef = null;
  if (pending) await (await pending.catch(() => null))?.close();
}

/** Tests: forget everything. */
export async function resetShell(): Promise<void> {
  await closeHost();
  context = null;
  syncDb = null;
}
