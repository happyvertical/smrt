// Process-wide holders: where the shell gets its database, its data root and
// the app hosts (the user app's runtime). Everything server-side reaches
// them through here, so tests can configure a temp directory and a SQLite
// database without SvelteKit.
//
// TWO profiles (`ShellContext.profile`, the app-runtime profile):
//
// - `local` (the desktop and every test that does not say otherwise): ONE
//   owner and ONE app. The live host's `dataDir` is `<data root>/user-app`, a
//   plain directory inside the app-runtime data root, so the encrypted backup
//   that seals the root also seals app.db, snapshots and archives. No
//   symlinks. An open draft is a second host over `<data root>/user-app-draft`,
//   made and removed only by the engine (`forkDraft` / `discard`).
// - `cloud`: MANY owners, each with their own app. Every holder below is keyed
//   by the TENANT of the request (read from the verified session's tenant
//   context, never from a header, URL or body). The tenant's app is the
//   `App` row of that tenant (the tenant-to-app mapping), its data lives in
//   `<root>/tenants/<tenant id>/<app id>` and its draft copy next to it in
//   `<app id>-draft`, both validated ids under the configured root. A request
//   with no tenant refuses (401); nothing falls back to "the" app.
//
// TWO copies, never a "current" one: `getHost()` is the LIVE host, always;
// the draft host is reachable only through `hostFor('draft')` /
// `getDraftSlot()`, which callers reach by naming the copy (see target.ts).
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AppHost,
  bundledWorkerUrl,
  discardDraftDirectory,
  EngineError,
  type WorkerLimits,
  wantsBundledWorker,
} from '../../engine/index.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { AppImportCollection } from '../objects/AppImport.ts';
import { ChangeBatchCollection } from '../objects/ChangeBatch.ts';
import { ChangeCardCollection } from '../objects/ChangeCard.ts';
import { versionSummary } from '../ui/command-summary.ts';
import { publish, setTenantScopedEvents } from './events.ts';
import { PolicyError } from './owner.ts';
import type { Target } from './target.ts';
import { DraftVersionStore, ShellVersionStore } from './version-store.ts';

/** Where the open draft's copy lives under the data root (local profile). */
export const DRAFT_DIRNAME = 'user-app-draft';

/** The runtime profile the shell runs under. */
export type ShellProfile = 'local' | 'cloud';

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
  /** A workflow owns this draft until its proof passes. */
  hold?: string | null;
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
  /** V8 limits of each app worker thread (engine default when absent). */
  workerLimits?: WorkerLimits;
  /**
   * The app-runtime profile. Absent means `local` (the desktop, and every
   * test that does not choose). A function that throws or rejects leaves the
   * shell unusable: it never falls back to `local`.
   */
  profile?: () => ShellProfile | Promise<ShellProfile>;
}

/** Everything the shell holds for one app (one tenant's, or the local one). */
interface Holder {
  key: string;
  /** Cloud: the tenant of the app. Local: null. Directories and events use it. */
  tenantId: string | null;
  /**
   * The tenant the stores pin to: `tenantId` in cloud; on the desktop the
   * installation's one tenant (null when there is not exactly one), so a
   * store's reads and writes always sit in the same tenant whatever context
   * the caller (a request, an import job) happens to be in.
   */
  pin: string | null;
  hostPromise: Promise<AppHost> | null;
  hostRef: AppHost | null;
  storeRef: ShellVersionStore | null;
  slotRef: DraftSlot | null;
  /** Where the draft copy goes (known once the live host is open). */
  draftDir: string | null;
}

let context: ShellContext | null = null;
let syncDb: DatabaseInterface | null = null;
let profileCache: ShellProfile | null = null;
const holders = new Map<string, Holder>();

export function configureShell(next: ShellContext): void {
  context = next;
  profileCache = null;
}

function requireContext(): ShellContext {
  if (!context)
    throw new Error('the shell is not configured (call configureShell first)');
  return context;
}

/** The profile this process runs under (resolved once, then cached). */
export async function shellProfile(): Promise<ShellProfile> {
  if (profileCache) return profileCache;
  const resolve = requireContext().profile;
  const value = resolve ? await resolve() : 'local';
  if (value !== 'local' && value !== 'cloud')
    throw new Error('the shell profile is not known');
  profileCache = value;
  setTenantScopedEvents(value === 'cloud');
  return value;
}

/** The cached profile once `shellProfile()` has resolved; null before. */
export function shellProfileSync(): ShellProfile | null {
  return profileCache;
}

/**
 * Refuse a surface that only exists on the desktop (the loopback owner link,
 * the data-root lease, an engine that runs a program or signs in on the
 * server's own machine). In the cloud profile it is a 404, as if the route did
 * not exist.
 */
export async function requireLocalProfile(what: string): Promise<void> {
  if ((await shellProfile()) !== 'local')
    throw new EngineError(
      `${what} is not available in the hosted app`,
      'not_found',
    );
}

/** The counterpart: a surface that only exists in the cloud profile. */
export async function requireCloudProfile(what: string): Promise<void> {
  if ((await shellProfile()) !== 'cloud')
    throw new EngineError(`${what} is not available here`, 'not_found');
}

/**
 * The shell's database. In the hosted app it is handed out only inside a
 * tenant's own context: the shell models are scoped to a tenant by that
 * context, so a path that reached the database with none would read every
 * tenant's rows. It refuses instead (401).
 */
export async function getShellDb(): Promise<DatabaseInterface> {
  if ((await shellProfile()) === 'cloud') requestTenant();
  const db = await requireContext().db();
  syncDb = db;
  return db;
}

/**
 * The database for the sign-in flow, which runs before any tenant context
 * exists. Cloud profile only, and only `accounts.ts` / `cloud-auth.ts` (the
 * global user, tenant and membership tables) may use it: the shell's own
 * tenant-scoped models go through {@link getShellDb}.
 */
export async function getAccountsDb(): Promise<DatabaseInterface> {
  await requireCloudProfile('Sign-in with an account');
  return requireContext().db();
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

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A tenant or app id safe to use as a directory name, or a refusal. */
export function safeId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ID.test(value))
    throw new Error(`${what} is not a valid id`);
  return value.toLowerCase();
}

/**
 * The directories of one tenant's app under the configured root: the live
 * data and the draft copy beside it. Both are checked to lie inside
 * `<root>/tenants/<tenant id>`; ids are validated, never a path from input.
 */
export function tenantAppDirs(
  root: string,
  tenantId: string,
  appId: string,
): { live: string; draft: string } {
  const tenant = safeId(tenantId, 'the tenant');
  const app = safeId(appId, 'the app');
  const base = resolve(root, 'tenants', tenant);
  const live = join(base, app);
  const draft = join(base, `${app}-draft`);
  for (const dir of [live, draft])
    if (!resolve(dir).startsWith(base + sep))
      throw new Error('the app directory is outside its tenant directory');
  return { live, draft };
}

function workerUrl(): URL | string {
  const configured = requireContext().workerUrl;
  if (configured) return configured;
  // SMRT_APP_SHELL_WORKER=bundle: the split worker bundle (#5213).
  if (wantsBundledWorker()) {
    const bundled = bundledWorkerUrl();
    if (bundled) return bundled;
    throw new EngineError('the worker bundle is not built', 'refused');
  }
  // From source (dev, tests) the worker sits next to the engine; from a build
  // it is the package's published engine worker.
  const local = new URL('../../engine/app-worker.ts', import.meta.url);
  if (existsSync(fileURLToPath(local))) return local;
  return new URL(
    import.meta.resolve('@happyvertical/smrt-app-shell/engine/worker'),
  );
}

/**
 * The tenant of the running request, from the verified session's tenant
 * context. Cloud only; a request with none is refused.
 */
function requestTenant(): string {
  const tenantId = getCurrentTenant()?.tenantId;
  if (!tenantId) throw new PolicyError(401, 'sign in first');
  return safeId(tenantId, 'the tenant');
}

function holderOf(key: string, tenantId: string | null): Holder {
  let holder = holders.get(key);
  if (!holder) {
    holder = {
      key,
      tenantId,
      pin: tenantId,
      hostPromise: null,
      hostRef: null,
      storeRef: null,
      slotRef: null,
      draftDir: null,
    };
    holders.set(key, holder);
  }
  return holder;
}

/** The holder of the running request (async: resolves the profile). */
async function currentHolder(): Promise<Holder> {
  if ((await shellProfile()) === 'local') return holderOf('local', null);
  const tenantId = requestTenant();
  return holderOf(tenantId, tenantId);
}

/** Sync form, for the few sync callers; the profile is cached by then. */
function currentHolderSync(): Holder {
  const profile = profileCache;
  if (!profile) throw new Error('the shell profile is not resolved yet');
  if (profile === 'local') return holderOf('local', null);
  const tenantId = requestTenant();
  return holderOf(tenantId, tenantId);
}

/** Republish a host's events on the bus, tagged with the copy they came from. */
export function wireHostEvents(
  host: AppHost,
  target: Target,
  tenantId: string | null = null,
): void {
  let previous = host.def;
  host.on('changed', (e: { version: number; summary: string }) => {
    const summary = versionSummary(e.summary, previous, host.def);
    previous = host.def;
    publish(
      {
        type: 'changed',
        target,
        version: e.version,
        summary,
      },
      tenantId,
    );
  });
  host.on('records', (e: { model: string | null }) =>
    publish({ type: 'records', target, model: e.model }, tenantId),
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
  pin: string | null = null,
): Promise<AppHost> {
  return AppHost.open(dir, {
    store: new DraftVersionStore(db, id, pin),
    workerUrl: workerUrl(),
    workerLimits: requireContext().workerLimits,
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
  holder: Holder,
  db: DatabaseInterface,
  live: AppHost,
  dir: string,
): Promise<void> {
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
  const imports = await AppImportCollection.create({ db });
  const pending = await imports.list({ where: { draftId: slot.id }, limit: 1 });
  if (
    pending[0] &&
    !['review', 'published', 'discarded'].includes(pending[0].status)
  )
    slot.hold =
      'The workbook import is still being checked. Return to Import to finish or discard it.';
  holder.slotRef = slot;
  if (!existsSync(join(dir, 'app.db'))) {
    slot.problem = 'the draft copy is missing from the data folder';
    return;
  }
  try {
    slot.host = await openDraftHost(db, slot.id, dir, holder.pin);
    wireHostEvents(slot.host, 'draft', holder.tenantId);
  } catch (e) {
    slot.problem = `the draft cannot be opened: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The desktop's one tenant, or null when there is not exactly one. */
async function soleTenantId(db: DatabaseInterface): Promise<string | null> {
  try {
    const tenants = await (await TenantCollection.create({ db })).list({
      limit: 2,
    });
    return tenants.length === 1 ? ((tenants[0].id as string) ?? null) : null;
  } catch {
    return null;
  }
}

/** Where this holder's live data lives, and its draft copy. Creates the live directory. */
async function directoriesFor(
  holder: Holder,
  store: ShellVersionStore,
): Promise<{ live: string; draft: string }> {
  const root = await dataRoot();
  if (holder.tenantId === null)
    return {
      live: join(root, 'user-app'),
      draft: join(root, DRAFT_DIRNAME),
    };
  // The tenant's app: its `App` row is the tenant-to-app mapping. One app per
  // tenant today; the directory is keyed by the app's own id so a tenant can
  // hold several later.
  const app = await store.appRow();
  return tenantAppDirs(root, holder.tenantId, app.id as string);
}

/**
 * Changes waiting freeze live structure even when their working copy is not
 * open (a restart or a crash mid-rebuild): the cards are the truth, the copy
 * is rebuilt lazily by changes.ts.
 */
async function freezeForWaitingChanges(
  db: DatabaseInterface,
  live: AppHost,
): Promise<void> {
  const batches = await ChangeBatchCollection.create({ db });
  const cards = await ChangeCardCollection.create({ db });
  for (const status of ['open', 'held']) {
    for (const batch of await batches.list({ where: { status }, limit: 100 })) {
      const active = await cards.list({
        where: { batchId: batch.id as string, status: 'active' },
        limit: 1,
      });
      if (active.length) {
        live.setFrozen(true);
        return;
      }
    }
  }
}

/** The LIVE host of the request's app, opened on first use. It is never the draft. */
export async function getHost(): Promise<AppHost> {
  const holder = await currentHolder();
  holder.hostPromise ??= (async () => {
    const db = await getShellDb();
    holder.pin ??= await soleTenantId(db);
    const store = new ShellVersionStore(db, holder.pin);
    const dirs = await directoriesFor(holder, store);
    mkdirSync(dirs.live, { recursive: true, mode: 0o700 });
    const host = await AppHost.open(dirs.live, {
      store,
      workerUrl: workerUrl(),
      workerLimits: requireContext().workerLimits,
    });
    wireHostEvents(host, 'live', holder.tenantId);
    try {
      await adoptDraft(holder, db, host, dirs.draft);
      await freezeForWaitingChanges(db, host);
    } catch (e) {
      // Never serve live thawed when we could not tell whether a draft is
      // open: fail the open; the next call retries.
      holder.slotRef = null;
      await host.close().catch(() => {});
      throw e;
    }
    // Tables imported before workbook bookkeeping stopped being required.
    await host.repairLegacyImport().catch(() => 0);
    holder.draftDir = dirs.draft;
    holder.storeRef = store;
    holder.hostRef = host;
    return host;
  })();
  const pending = holder.hostPromise;
  pending.catch(() => {
    if (holder.hostPromise === pending) holder.hostPromise = null; // retry
  });
  return pending;
}

/** The live host's version store (a publish names its draft on it). */
export async function getLiveStore(): Promise<ShellVersionStore> {
  await getHost();
  return (await currentHolder()).storeRef as ShellVersionStore;
}

/** The tenant the request's app belongs to: null on the desktop. */
export async function getAppTenantId(): Promise<string | null> {
  return (await currentHolder()).tenantId;
}

/** The tenant a draft's version store pins to (the live store's pin). */
export async function getStorePin(): Promise<string | null> {
  await getHost();
  return (await currentHolder()).pin;
}

/** Where a new draft's copy goes (the live host is open). */
export async function getDraftDir(): Promise<string> {
  await getHost();
  const dir = (await currentHolder()).draftDir;
  if (!dir) throw new Error('the draft directory is not known');
  return dir;
}

/** The request's live host if it is already open (sync, for list_changed wiring). */
export function openHost(): AppHost | null {
  try {
    return currentHolderSync().hostRef;
  } catch {
    return null;
  }
}

/** The open draft (live is open too), or null when there is none. */
export async function getDraftSlot(): Promise<DraftSlot | null> {
  await getHost();
  return (await currentHolder()).slotRef;
}

/** drafts.ts only: record the draft that just opened, or null once it is gone. */
export function setDraftSlot(slot: DraftSlot | null): void {
  currentHolderSync().slotRef = slot;
}

/**
 * The host for a copy the REQUEST named. `live` is always the live host;
 * `draft` is the draft host or a clear refusal, never live.
 */
export async function hostFor(target: Target): Promise<AppHost> {
  const live = await getHost();
  if (target === 'live') return live;
  const slot = (await currentHolder()).slotRef;
  if (!slot)
    throw new EngineError(
      'there is no draft open; start a draft first (or use the live app)',
      'not_found',
    );
  if (slot.hold) throw new EngineError(slot.hold, 'refused');
  if (!slot.host)
    throw new EngineError(
      `the draft "${slot.name}" cannot be used: ${slot.problem ?? 'it is not open'}. Discard it to carry on.`,
      'refused',
    );
  return slot.host;
}

export async function closeHost(): Promise<void> {
  const all = [...holders.values()];
  holders.clear();
  for (const holder of all) {
    const pending = holder.hostPromise;
    const slot = holder.slotRef;
    if (slot?.host) await slot.host.close().catch(() => {});
    if (pending) await (await pending.catch(() => null))?.close();
  }
}

/** Tests: forget everything. */
export async function resetShell(): Promise<void> {
  await closeHost();
  context = null;
  syncDb = null;
  profileCache = null;
  setTenantScopedEvents(false);
}
