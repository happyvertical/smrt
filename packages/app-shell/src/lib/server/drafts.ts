// The draft lifecycle: start, describe, preview, publish, discard.
//
// One draft at a time. The draft is a second app host over a COPY of the live
// data (engine: `forkDraft`); live keeps serving records but its structure is
// FROZEN while the draft is open (frozen again after every restart, in
// host.ts). Publishing replays the draft's changes onto live and is ALWAYS an
// Approval pinned to the preview's digest; discarding is a direct owner action
// from the UI and an Approval when a tool asks. All lifecycle changes run one
// at a time (`exclusive`), so a start cannot race a publish or a discard.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AppHost,
  discardDraftDirectory,
  EngineError,
  type PublishPreview,
  type PublishResult,
} from '@happyvertical/smrt-app-engine';
import { AppDraftCollection } from '../objects/AppDraft.ts';
import {
  type ApprovalAction,
  type PendingApproval,
  requestApproval,
} from './approvals.ts';
import { publish } from './events.ts';
import {
  DRAFT_DIRNAME,
  type DraftSlot,
  dataRoot,
  getDraftSlot,
  getHost,
  getLiveStore,
  getShellDb,
  hostFor,
  setDraftSlot,
  wireHostEvents,
} from './host.ts';
import type { Target } from './target.ts';
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

export type DraftPublishResult = Omit<PublishResult, 'snapshot'> & {
  draft: string;
};

let tail: Promise<unknown> = Promise.resolve();

/** Run lifecycle work one at a time. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
}

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

/** Start a draft. Live structure is frozen from here until it is published or discarded. */
export function startDraft(name: unknown, ownerId: string): Promise<DraftInfo> {
  return exclusive(async () => {
    const live = await getHost();
    const open = await getDraftSlot();
    if (open)
      throw new EngineError(
        `a draft is already open ("${open.name}"); publish or discard it first`,
        'refused',
      );
    const db = await getShellDb();
    const dir = join(await dataRoot(), DRAFT_DIRNAME);
    // A leftover copy no row refers to (host.ts removes these at start): the
    // engine only removes a directory that is one of its own drafts.
    if (existsSync(dir)) discardDraftDirectory(dir);
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
      host = await live.forkDraft(dir, {
        store: new DraftVersionStore(db, id),
      });
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
    wireHostEvents(host, 'draft');
    setDraftSlot({ id, name: row.name, dir, host, problem: null });
    publish({ type: 'draft', status: 'started', id, name: row.name });
    return (await draftInfo()) as DraftInfo;
  });
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
  const preview = await live.previewPublish(host);
  return { draft: (await draftInfo()) as DraftInfo, preview };
}

/**
 * Ask to publish: ALWAYS an Approval, pinned to the digest of a preview taken
 * now. `expect`, when given, is the digest the person reviewed: a draft that
 * changed since is refused (review it again), not published.
 */
export async function requestPublish(
  expect: unknown,
  requestedBy: string,
): Promise<PendingApproval> {
  if (expect !== undefined && expect !== null && typeof expect !== 'string')
    throw new EngineError('expect must be the digest of a preview', 'invalid');
  const { draft, preview } = await previewDraft();
  if (expect && expect !== preview.digest)
    throw new EngineError(
      'the draft changed since it was reviewed; review it again',
      'refused',
    );
  const action: ApprovalAction = {
    kind: 'publish-draft',
    draftId: draft.id,
    draftName: draft.name,
    digest: preview.digest,
  };
  const n = preview.versions.length;
  return requestApproval(
    action,
    {
      summary: `Publish draft "${draft.name}": ${n} change${n === 1 ? '' : 's'} become live`,
      risky: true,
      preview: { draft: draft.name, ...preview } as Record<string, unknown>,
    },
    requestedBy,
  );
}

/**
 * Apply an APPROVED publish. Called only from approvals.ts, which passes the
 * engine call (it owns the `approved` flag). Refuses if this is not the open
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
export function discardNow(expectId?: string): Promise<{ discarded: string }> {
  return exclusive(async () => {
    const live = await getHost();
    const slot = await getDraftSlot();
    if (!slot) throw new EngineError('there is no draft open', 'not_found');
    if (expectId && expectId !== slot.id)
      throw new EngineError(
        'this is not the draft that was asked about',
        'refused',
      );
    if (slot.host) await slot.host.discard();
    else if (existsSync(slot.dir)) discardDraftDirectory(slot.dir);
    const row = await (
      await AppDraftCollection.create({ db: await getShellDb() })
    ).get(slot.id);
    if (row) {
      row.status = 'discarded';
      row.note = 'discarded';
      row.endedAt = new Date().toISOString();
      await row.save();
    }
    setDraftSlot(null);
    live.setFrozen(false);
    publish({
      type: 'draft',
      status: 'discarded',
      id: slot.id,
      name: slot.name,
    });
    return { discarded: slot.name };
  });
}

/** Ask to discard (a tool's way): an Approval. */
export async function requestDiscard(
  requestedBy: string,
): Promise<PendingApproval> {
  const draft = await draftInfo();
  if (!draft) throw new EngineError('there is no draft open', 'not_found');
  return requestApproval(
    { kind: 'discard-draft', draftId: draft.id, draftName: draft.name },
    {
      summary: `Discard draft "${draft.name}" and everything built in it`,
      risky: true,
      preview: {
        draft: draft.name,
        changes: draft.changes,
        note: 'The draft is thrown away. The live app is not changed.',
      },
    },
    requestedBy,
  );
}

/**
 * The app as one copy now: `{ mode, draft, frozen, ...describe }`. `mode` is
 * the copy this describes; `draft` is the open draft (the same object whichever
 * copy is described, so a view of live can show the draft strip); `frozen` is
 * whether THIS copy's structure is frozen.
 */
export async function describeCopy(target: Target) {
  const host = await hostFor(target);
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
