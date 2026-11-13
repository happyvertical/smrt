// Process-wide holders: where the shell gets its database, its data root and
// the app hosts (the user app's runtime). Everything server-side reaches
// them through here, so tests can configure a temp directory and a SQLite
// database without SvelteKit.
//
// Data layout: the live host's `dataDir` is `<data root>/user-app`, a plain
// directory inside the app-runtime data root, so the encrypted backup that
// seals the root also seals app.db, snapshots and archives. No symlinks. An
// open draft is a second host over `<data root>/user-app-draft`, made and
// removed only by the engine (`forkDraft` / `discard`).
//
// TWO holders, never a "current" one: `getHost()` is the LIVE host, always;
// the draft host is reachable only through `hostFor('draft')` /
// `getDraftSlot()`, which callers reach by naming the copy (see target.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AppHost,
  discardDraftDirectory,
  EngineError,
} from '../../engine/index.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { publish } from './events.ts';
import type { Target } from './target.ts';
import { DraftVersionStore, ShellVersionStore } from './version-store.ts';

/** Where the open draft's copy lives under the data root. */
export const DRAFT_DIRNAME = 'user-app-draft';

/** The open draft as the shell holds it. */
export interface DraftSlot {
  id: string;
  name: string;
  /** The draft's data directory. */
  dir: string;
  /** The draft host; null when it could not be opened (see `problem`). */
  host: AppHost | null;
  /** Why `host` is null, or null. */
  problem: string | null;
}

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
let storeRef: ShellVersionStore | null = null;
let slotRef: DraftSlot | null = null;
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

/** Republish a host's events on the bus, tagged with the copy they came from. */
export function wireHostEvents(host: AppHost, target: Target): void {
  host.on('changed', (e: { version: number; summary: string }) =>
    publish({
      type: 'changed',
      target,
      version: e.version,
      summary: e.summary,
    }),
  );
  host.on('records', (e: { model: string | null }) =>
    publish({ type: 'records', target, model: e.model }),
  );
}

/**
 * Open a draft's host. `autoApprove` (risky changes need no approval) is the
 * draft's alone: the engine refuses it unless `dir` holds its draft marker, so
 * this call can never hand it to the live host.
 */
export function openDraftHost(
  db: DatabaseInterface,
  id: string,
  dir: string,
): Promise<AppHost> {
  return AppHost.open(dir, {
    store: new DraftVersionStore(db, id),
    workerUrl: workerUrl(),
    autoApprove: true,
  });
}

/**
 * After the live host is open: settle drafts a restart interrupted, and if one
 * is open, FREEZE live structure again (the freeze is not persisted) and
 * reopen the draft host. A draft whose copy cannot be opened still counts as
 * open (live stays frozen) with `problem` saying why; the owner discards it.
 */
async function adoptDraft(
  db: DatabaseInterface,
  live: AppHost,
  root: string,
): Promise<void> {
  const dir = join(root, DRAFT_DIRNAME);
  const drafts = await AppDraftCollection.create({ db });
  const now = new Date().toISOString();
  const rows = await drafts.list({ limit: 1000 });
  for (const row of rows.filter((r) => r.status === 'starting')) {
    row.status = 'discarded';
    row.note = 'the start did not finish';
    row.endedAt = now;
    await row.save();
  }
  const open = rows
    .filter((r) => r.status === 'open')
    .sort((a, b) => (String(a.createdAt) < String(b.createdAt) ? 1 : -1));
  for (const extra of open.slice(1)) {
    extra.status = 'discarded';
    extra.note = 'another draft was open';
    extra.endedAt = now;
    await extra.save();
  }
  const row = open[0];
  if (!row) {
    // A copy nothing refers to any more (a crash after a publish or discard
    // was recorded): the engine removes it, and only if it is one of its own.
    if (existsSync(dir))
      try {
        discardDraftDirectory(dir);
      } catch {
        // not removable (no marker, a symlink): left alone, never forced
      }
    return;
  }
  live.setFrozen(true);
  const slot: DraftSlot = {
    id: row.id as string,
    name: row.name,
    dir,
    host: null,
    problem: null,
  };
  slotRef = slot;
  if (!existsSync(join(dir, 'app.db'))) {
    slot.problem = 'the draft copy is missing from the data folder';
    return;
  }
  try {
    slot.host = await openDraftHost(db, slot.id, dir);
    wireHostEvents(slot.host, 'draft');
  } catch (e) {
    slot.problem = `the draft cannot be opened: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The LIVE host, opened on first use. It is never the draft. */
export function getHost(): Promise<AppHost> {
  hostPromise ??= (async () => {
    const db = await getShellDb();
    const root = await dataRoot();
    const dir = join(root, 'user-app');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = new ShellVersionStore(db);
    const host = await AppHost.open(dir, {
      store,
      workerUrl: workerUrl(),
    });
    wireHostEvents(host, 'live');
    try {
      await adoptDraft(db, host, root);
    } catch (e) {
      // Never serve live thawed when we could not tell whether a draft is
      // open: fail the open; the next call retries.
      slotRef = null;
      await host.close().catch(() => {});
      throw e;
    }
    storeRef = store;
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

/** The live host's version store (a publish names its draft on it). */
export async function getLiveStore(): Promise<ShellVersionStore> {
  await getHost();
  return storeRef as ShellVersionStore;
}

/** The live host if it is already open (sync, for list_changed wiring). */
export function openHost(): AppHost | null {
  return hostRef;
}

/** The open draft (live is open too), or null when there is none. */
export async function getDraftSlot(): Promise<DraftSlot | null> {
  await getHost();
  return slotRef;
}

/** drafts.ts only: record the draft that just opened, or null once it is gone. */
export function setDraftSlot(slot: DraftSlot | null): void {
  slotRef = slot;
}

/**
 * The host for a copy the REQUEST named. `live` is always the live host;
 * `draft` is the draft host or a clear refusal, never live.
 */
export async function hostFor(target: Target): Promise<AppHost> {
  const live = await getHost();
  if (target === 'live') return live;
  const slot = slotRef;
  if (!slot)
    throw new EngineError(
      'there is no draft open; start a draft first (or use the live app)',
      'not_found',
    );
  if (!slot.host)
    throw new EngineError(
      `the draft "${slot.name}" cannot be used: ${slot.problem ?? 'it is not open'}. Discard it to carry on.`,
      'refused',
    );
  return slot.host;
}

export async function closeHost(): Promise<void> {
  const pending = hostPromise;
  const slot = slotRef;
  hostPromise = null;
  hostRef = null;
  storeRef = null;
  slotRef = null;
  if (slot?.host) await slot.host.close().catch(() => {});
  if (pending) await (await pending.catch(() => null))?.close();
}

/** Tests: forget everything. */
export async function resetShell(): Promise<void> {
  await closeHost();
  context = null;
  syncDb = null;
}
