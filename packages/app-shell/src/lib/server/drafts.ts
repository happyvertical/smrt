// The working-copy lifecycle: start, describe, preview, publish, discard.
//
// Owners never see this as "a draft" (#5178): `changes.ts` owns the batch of
// changes waiting and uses this module as the private copy beneath it. One
// copy at a time. It is a second app host over a COPY of the live data
// (engine: `forkDraft`); live keeps serving records but its structure is
// FROZEN while it is open (frozen again after every restart, in host.ts).
// Publishing replays the copy's changes onto live and happens only through the
// owner's Apply (an `apply-batch` Approval pinned to the preview's digest,
// approvals.ts). All lifecycle changes run one at a time (`exclusive`), so a
// start cannot race a publish or a discard.

import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AppHost,
  EngineError,
  type PublishPreview as EnginePublishPreview,
  type PublishResult,
} from '../../engine/index.ts';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import { versionSummary } from '../ui/command-summary.ts';
import type { ReportChange } from '../ui/reports.ts';
import { reportChanges } from '../ui/reports.ts';
import type { FieldDef } from '../ui/types.ts';
import { publish } from './events.ts';
import {
  type DraftSlot,
  discardStaleDraft,
  getAppTenantId,
  getDraftDir,
  getDraftSlot,
  getHost,
  getLiveStore,
  getShellDb,
  getStorePin,
  hostFor,
  setDraftSlot,
  wireHostEvents,
  withAppLease,
  withDraftConnections,
} from './host.ts';
import { type Principal, principalFor } from './owner.ts';
import type { Target } from './target.ts';
import { createTenantQueue } from './tenant-queue.ts';
import { DraftVersionStore } from './version-store.ts';

/** What the UI and tools see of the open draft. */
export interface DraftInfo {
  id: string;
  name: string;
  status: 'open';
  /** The live version the draft was copied from. */
  baseVersion: number;
  /** The draft's current version (null when its copy cannot be opened). */
  version: number | null;
  /** Changes made in the draft (its versions after the base). */
  changes: number;
  createdAt: string;
  createdBy: string;
  /** The live version now. */
  liveVersion: number;
  /** Live structure is frozen while a draft is open. */
  liveFrozen: boolean;
  /** False when it cannot be published (see `problem`); discard is always offered. */
  publishable: boolean;
  problem: string | null;
  /** What opening the draft's copy found: `rolled-back` = an interrupted publish was undone (publish again). */
  recovery: 'none' | 'rolled-forward' | 'rolled-back';
}

type PublishPreview = EnginePublishPreview & {
  modelLabels?: Record<string, string>;
  reportChanges?: ReportChange[];
  fields?: Record<string, Record<string, FieldDef>>;
};

export type DraftPublishResult = Omit<PublishResult, 'snapshot'> & {
  draft: string;
};

/** Run lifecycle work one at a time per tenant. */
const queue = createTenantQueue();
// ...and the app stays open until the workflow is done (see `withAppLease`).
const exclusive = <T>(fn: () => Promise<T>): Promise<T> =>
  queue(() => withAppLease(fn));

function clean(name: unknown): string {
  const text =
    typeof name === 'string'
      ? Array.from(name)
          .filter((ch) => ch.charCodeAt(0) >= 0x20 && ch !== '\u007f')
          .join('')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
  return text ? text.slice(0, 60) : 'Draft';
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Why the open draft cannot be published, or null. */
function unpublishable(slot: DraftSlot, live: AppHost): string | null {
  if (slot.hold) return slot.hold;
  if (!slot.host) return slot.problem ?? 'the draft copy is not open';
  const marker = slot.host.draft;
  if (!marker) return 'the draft copy is not marked as a draft';
  if (realOf(marker.liveDir) !== realOf(live.dataDir))
    return 'the draft was made from another app or location (the data folder was restored or moved); it cannot be published. Discard it and start again';
  return null;
}

/** The open draft, or null. Safe to call for any request. */
export async function draftInfo(): Promise<DraftInfo | null> {
  const live = await getHost();
  const slot = await getDraftSlot();
  if (!slot) return null;
  const row = await (
    await AppDraftCollection.create({ db: await getShellDb() })
  ).get(slot.id);
  let changes = 0;
  if (slot.host) {
    try {
      changes = (await slot.host.draftChain()).versions.length;
    } catch {
      changes = 0;
    }
  }
  const problem = unpublishable(slot, live);
  return {
    id: slot.id,
    name: slot.name,
    status: 'open',
    baseVersion: Number(
      row?.baseVersion ?? slot.host?.draft?.baseVersion ?? -1,
    ),
    version: slot.host ? slot.host.version : null,
    changes,
    createdAt: String(row?.createdAt ?? ''),
    createdBy: row?.createdBy ?? '',
    liveVersion: live.version,
    liveFrozen: live.frozen,
    publishable: problem === null,
    problem,
    recovery: slot.host?.recovery ?? 'none',
  };
}

/** What a fork step is given: the new copy's row id, directory and (empty) version store. */
export interface DraftForkContext {
  id: string;
  dir: string;
  store: DraftVersionStore;
  live: AppHost;
}

/**
 * Start a working copy with `fork` making the host (a plain `forkDraft`, or a
 * rebuild that replays commands). Live structure is frozen from here until it
 * is published or discarded.
 */
export function startDraftWith(
  fork: (ctx: DraftForkContext) => Promise<AppHost>,
  name: unknown,
  ownerId: string,
  beforeFork?: (id: string) => Promise<void>,
  hold?: string,
): Promise<DraftInfo> {
  return exclusive(async () => {
    const live = await getHost();
    const open = await getDraftSlot();
    if (open)
      throw new EngineError(
        `a draft is already open ("${open.name}"); publish or discard it first`,
        'refused',
      );
    // A draft forks live, so live is repaired first (it is not frozen yet).
    await live.repairLegacyImport().catch(() => 0);
    const db = await getShellDb();
    const dir = await getDraftDir();
    const tenantId = await getAppTenantId();
    const pin = await getStorePin();
    // A leftover copy no row refers to (host.ts removes these at start): the
    // engine only removes a directory that is one of its own drafts.
    if (existsSync(dir)) await discardStaleDraft(dir);
    const drafts = await AppDraftCollection.create({ db });
    const row = await drafts.create({
      name: clean(name),
      status: 'starting',
      createdBy: ownerId,
      createdAt: new Date().toISOString(),
    });
    await row.save();
    const id = row.id as string;
    // Frozen BEFORE the copy: no structural change can land between the row
    // and the copy (the copy itself runs in the live change queue).
    live.setFrozen(true);
    let host: AppHost | null = null;
    try {
      await beforeFork?.(id);
      host = await withDraftConnections(() =>
        fork({
          id,
          dir,
          live,
          store: new DraftVersionStore(db, id, pin),
        }),
      );
      // The draft's store moved the row's pointer: re-read it before updating.
      const fresh = (await drafts.get(id)) ?? row;
      fresh.status = 'open';
      fresh.baseVersion = host.draft?.baseVersion ?? live.version;
      await fresh.save();
    } catch (e) {
      live.setFrozen(false);
      if (host) await host.discard().catch(() => {});
      const failed = await drafts.get(id).catch(() => null);
      if (failed) {
        failed.status = 'discarded';
        failed.note = 'the start failed';
        failed.endedAt = new Date().toISOString();
        await failed.save().catch(() => {});
      }
      throw e;
    }
    wireHostEvents(host, 'draft', tenantId);
    setDraftSlot({ id, name: row.name, dir, host, problem: null, hold });
    publish({ type: 'draft', status: 'started', id, name: row.name });
    return (await draftInfo()) as DraftInfo;
  });
}

/** Start an empty working copy (a plain fork of live). */
export function startDraft(
  name: unknown,
  owner: Principal,
  beforeFork?: (id: string) => Promise<void>,
  hold?: string,
): Promise<DraftInfo> {
  return startDraftWith(
    ({ dir, store, live }) =>
      live.forkDraft(principalFor(owner, live.def), dir, { store }),
    name,
    owner.id,
    beforeFork,
    hold,
  );
}

async function usableSlot(): Promise<{
  slot: DraftSlot;
  host: AppHost;
  live: AppHost;
}> {
  const live = await getHost();
  const slot = await getDraftSlot();
  if (!slot) throw new EngineError('there is no draft open', 'not_found');
  const problem = unpublishable(slot, live);
  if (problem || !slot.host)
    throw new EngineError(problem ?? 'the draft cannot be used', 'refused');
  return { slot, host: slot.host, live };
}

/**
 * What publishing would do (a rehearsal on a copy of the CURRENT live data;
 * live is only read). `preview.digest` pins the answer for the publish Approval.
 */
export async function previewDraft(): Promise<{
  draft: DraftInfo;
  preview: PublishPreview;
}> {
  const { host, live } = await usableSlot();
  const preview: PublishPreview = await live.previewPublish(host);
  const chain = await host.draftChain();
  const records = new Map(
    [chain.base, ...chain.versions].map((v) => [v.version, v]),
  );
  preview.fields = Object.fromEntries(
    Object.entries(host.describe().models).map(([name, model]) => [
      name,
      { ...live.describe().models[name]?.fields, ...model.fields },
    ]),
  );
  const descriptions = { ...live.describe().models, ...host.describe().models };
  const relevantModels = new Set([
    ...preview.definition.modelsAdded,
    ...preview.definition.modelsRemoved,
    ...Object.keys(preview.definition.models),
    ...(preview.fieldRenames ?? []).map((rename) => rename.model),
    ...preview.methods.map((method) => method.model),
    ...preview.versions.flatMap((version) =>
      (version.dataSteps ?? []).flatMap((step) => [
        step.model,
        ...Object.keys(
          (step.counts.references ?? {}) as Record<string, unknown>,
        ),
      ]),
    ),
  ]);
  preview.modelLabels = Object.fromEntries(
    [...relevantModels].map((name) => [
      name,
      descriptions[name]?.label ?? name,
    ]),
  );
  preview.reportChanges = [];
  for (const version of preview.versions) {
    const record = records.get(version.draftVersion);
    if (!record) continue;
    (version as typeof version & { humanSummary?: string }).humanSummary =
      versionSummary(
        record.summary,
        records.get(record.parent ?? -1)?.definition,
        record.definition,
      );
    const changes = reportChanges(
      records.get(record.parent ?? -1)?.definition.reports ?? {},
      record.definition.reports ?? {},
      record.summary,
    );
    preview.reportChanges.push(...changes);
    if (changes.length)
      version.summary = `${record.summary} ${changes.map((c) => c.text).join(' ')}`;
  }
  return { draft: (await draftInfo()) as DraftInfo, preview };
}

/**
 * Apply an APPROVED publish. Called only from changes.ts, whose Apply is
 * reached through approvals.ts, which passes the engine call (it owns the
 * `approved` flag). Refuses if this is not the open
 * draft any more, or if the draft is not exactly what the approval was pinned
 * to (the engine compares the digest against the chain as it is now).
 */
export function publishApproved(
  action: { draftId: string; digest: string },
  engine: (
    live: AppHost,
    draft: AppHost,
    options: { expect: string; draftName: string },
  ) => Promise<PublishResult>,
): Promise<DraftPublishResult> {
  return exclusive(async () => {
    const { slot, host, live } = await usableSlot();
    if (slot.id !== action.draftId)
      throw new EngineError(
        'this approval was for a draft that is no longer open',
        'refused',
      );
    const store = await getLiveStore();
    // The draft's `published` mark rides in the store commit's transaction.
    store.publishing = { draftId: slot.id };
    let result: PublishResult;
    try {
      result = await engine(live, host, {
        expect: action.digest,
        draftName: slot.name,
      });
    } finally {
      store.publishing = null;
    }
    // Final: live has the versions and the row says `published`.
    setDraftSlot(null);
    try {
      await host.discard();
    } catch (e) {
      // biome-ignore lint/suspicious/noConsole: message only; the stray copy is removed at the next start
      console.error(
        'draft copy not removed after publish:',
        e instanceof Error ? e.message : 'unknown error',
      );
    }
    live.setFrozen(false);
    await live.repairLegacyImport().catch(() => 0);
    publish({
      type: 'draft',
      status: 'published',
      id: slot.id,
      name: slot.name,
    });
    // The retained pre-publish copy's path stays on this machine.
    const { snapshot: _kept, ...shown } = result;
    return { ...shown, draft: slot.name };
  });
}

/** Discard the open draft now: closes it, deletes its copy, thaws live. Owner's direct action. */
export function discardNow(
  expectId?: string,
  options: {
    expectEmpty?: boolean;
    /** Rebuilding the same changes: no `discarded` event, and live stays frozen. */
    rebuilding?: boolean;
  } = {},
): Promise<{ discarded: string }> {
  return exclusive(async () => {
    const live = await getHost();
    const slot = await getDraftSlot();
    if (!slot) throw new EngineError('there is no draft open', 'not_found');
    if (expectId && expectId !== slot.id)
      throw new EngineError(
        'this is not the draft that was asked about',
        'refused',
      );
    // A change that landed after the caller's own check keeps the draft. The
    // empty check and the close run together on the draft host's change queue,
    // the same one edits use, so an edit cannot land between them (#5122).
    if (options.expectEmpty) {
      if (!slot.host || !(await slot.host.discardIfEmpty()))
        throw new EngineError('this draft has changes', 'refused');
    } else if (slot.host) await slot.host.discard();
    else if (existsSync(slot.dir)) await discardStaleDraft(slot.dir);
    const row = await (
      await AppDraftCollection.create({ db: await getShellDb() })
    ).get(slot.id);
    if (row) {
      row.status = 'discarded';
      row.note = options.rebuilding ? 'rebuilt' : 'discarded';
      row.endedAt = new Date().toISOString();
      await row.save();
    }
    setDraftSlot(null);
    if (options.rebuilding) return { discarded: slot.name };
    live.setFrozen(false);
    await live.repairLegacyImport().catch(() => 0);
    publish({
      type: 'draft',
      status: 'discarded',
      id: slot.id,
      name: slot.name,
    });
    return { discarded: slot.name };
  });
}

/**
 * Close the open draft only when it is provably unused: no hold, an open copy
 * and an empty change chain. A draft with changes, or one that cannot be read,
 * stays. Lets an import take over a draft the owner never used.
 */
export async function discardIfUnused(): Promise<boolean> {
  const slot = await getDraftSlot();
  if (!slot || slot.hold || !slot.host) return false;
  try {
    if ((await slot.host.draftChain()).versions.length > 0) return false;
  } catch {
    return false;
  }
  try {
    await discardNow(slot.id, { expectEmpty: true });
  } catch (error) {
    const current = await getDraftSlot();
    if (current?.id === slot.id) {
      if (error instanceof EngineError && error.code === 'refused')
        return false;
      throw error;
    }
  }
  return true;
}

/**
 * The app as one copy now: `{ mode, draft, frozen, ...describe }`. `mode` is
 * the copy this describes; `draft` is the open draft (the same object whichever
 * copy is described, so a view of live can show the draft strip); `frozen` is
 * whether THIS copy's structure is frozen.
 */
export async function describeCopy(target: Target, using?: AppHost) {
  const host = using ?? (await hostFor(target));
  return {
    mode: target,
    draft: await draftInfo(),
    frozen: host.frozen,
    ...host.describe(),
  };
}

/**
 * The versions of one copy. Live: a published draft's versions carry
 * `publish: { draftId, name }` so History groups them. Draft: the live
 * version it was copied from (its base) is left out, it is not a change made
 * there.
 */
export async function historyFor(target: Target) {
  const host = await hostFor(target);
  const versions = await host.versions();
  const chain =
    target === 'live'
      ? await (await getLiveStore()).list()
      : await host.draftChain().then((c) => [c.base, ...c.versions]);
  const records = new Map(chain.map((v) => [v.version, v]));
  for (const version of versions) {
    const record = records.get(version.version);
    if (!record) continue;
    const changes = reportChanges(
      records.get(record.parent ?? -1)?.definition.reports ?? {},
      record.definition.reports ?? {},
      record.summary,
    );
    if (changes.length)
      version.summary = `${record.summary} ${changes.map((c) => c.text).join(' ')}`;
    Object.assign(version, {
      humanSummary: versionSummary(
        record.summary,
        records.get(record.parent ?? -1)?.definition,
        record.definition,
      ),
    });
  }
  if (target === 'draft') {
    const base = host.draft?.baseVersion;
    return versions
      .filter((v) => v.version !== base)
      .map((v) => ({ ...v, publish: null }));
  }
  const groups = new Map<number, { draftId: string; name: string }>();
  const drafts = await AppDraftCollection.create({ db: await getShellDb() });
  for (const d of await drafts.list({
    where: { status: 'published' },
    limit: 1000,
  })) {
    try {
      for (const n of JSON.parse(d.publishedVersions || '[]') as number[])
        groups.set(n, { draftId: d.id as string, name: d.name });
    } catch {
      // an unreadable list just leaves that publish ungrouped
    }
  }
  return versions.map((v) => ({
    ...v,
    publish: groups.get(v.version) ?? null,
  }));
}
