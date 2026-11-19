// ChangeEngine: the engine's side of "changes waiting" (#5178, slice #5202).
//
// The owner's batch is an ordered list of commands. The draft host is only a
// private working copy of it: `rebuild` makes a fresh one from live, `checkBatch`
// rehearses it on a fresh copy of CURRENT live data, `publishDraft` applies it
// and `undoBatch` takes the applied versions back off. The SQLite adapter below
// is a thin layer over `forkDraft` / `previewPublish` / `publishDraft` /
// `undoTo`; a hosted engine (#5187) can implement the same interface.
//
// `principal` (#5188) and `fence` (#5190) are placeholders: every method takes
// them, the SQLite adapter ignores them.
import { createHash } from 'node:crypto';
import type { Command } from './commands.ts';
import { type AppDefinition, type Step, validate } from './definition.ts';
import { EngineError } from './errors.ts';
import type {
  AppHost,
  ChangeResult,
  ExecuteResult,
  ForkDraftOptions,
  PublishDataStep,
  PublishOptions,
  PublishPreview,
  PublishResult,
} from './host.ts';
import { canonical, chainDigest, type DraftChain } from './publish.ts';

/** Who is asking. Enforced by the hosted engine (#5188); unused on SQLite. */
export interface ChangePrincipal {
  id: string;
}

/** Generation fence (#5190): a hosted engine refuses work from a stale generation. Unused on SQLite. */
export interface ChangeFence {
  generation: number;
}

/** One command of the batch, keyed by whatever the caller uses to name it (a card id). */
export interface BatchCommand {
  key: string;
  command: Command;
}

export type BlockerCode =
  | 'depends_on_removed'
  | 'replay_failed'
  | 'report_uses_removed_field'
  | 'same_field_twice'
  | 'base_moved';

export interface BatchBlocker {
  code: BlockerCode;
  message: string;
  /** `rebuild`: the command that no longer applies. */
  key?: string;
  /** `checkBatch`: `table.column`, for same_field_twice. */
  field?: string;
  /**
   * `checkBatch`: the working-copy version numbers (`DraftChain` records) the
   * blocker is about, so the caller can name the owning cards. Absent means
   * the whole batch (base_moved, an unattributable replay failure).
   */
  versions?: number[];
}

export interface RebuildInput {
  /** Where the new working copy goes (must not exist). The caller discards any older one. */
  draftDir: string;
  /** The new copy's version store, EMPTY. */
  store: ForkDraftOptions['store'];
  /** Ordered, active commands. */
  commands: BatchCommand[];
  author: string;
  /**
   * Abort midway: the new copy is discarded, live is untouched and the call
   * rejects. Checked before each command.
   */
  signal?: AbortSignal;
}

export interface RebuildResult {
  draft: AppHost;
  /** The commands that applied, in order, with the draft version each made. */
  applied: { key: string; version: number }[];
  /** Commands that no longer apply (`depends_on_removed`); the rest still applied. */
  blockers: BatchBlocker[];
}

export interface BatchOverwrites {
  /** Existing rows an upsert load would update. */
  recordsUpdated: number;
  /** Rows merged away by mergeRecords. */
  recordsMerged: number;
  /** Values the changes archive (what undo restores from). */
  archivedValues: number;
  archivedTables: number;
  /** The per-step counts the figures come from. */
  dataSteps: PublishDataStep[];
}

export interface BatchCheck {
  /** No blockers. Overwrites never block (owner decision on #5178). */
  ok: boolean;
  blockers: BatchBlocker[];
  /** Shown and pinned by the digest, never blocking. */
  overwrites: BatchOverwrites;
  /** The engine's `replayDigest`: what `publishDraft` is given as `expect`. Null when there is nothing to check. */
  engineDigest: string | null;
  /**
   * What the owner's review pins (input to `batchDigest`): the chain plus ONLY
   * the figures shown as overwrites (rows a load would update, rows a merge
   * removes). Records added to live while changes wait that overwrite nothing
   * do not move it; a record that turns an insert into an update does.
   */
  reviewDigest: string | null;
  /** The rehearsal, absent when it could not run. */
  preview: PublishPreview | null;
}

export interface UndoBatchInput {
  /** The version numbers `publishDraft` returned (`PublishResult.versions`), oldest first. */
  versions: number[];
  author: string;
}

export interface ChangeEngine {
  /** A fresh working copy of live, EMPTY of changes. */
  forkDraft(
    principal: ChangePrincipal,
    live: AppHost,
    draftDir: string,
    opts: ForkDraftOptions,
    fence?: ChangeFence,
  ): Promise<AppHost>;
  previewPublish(
    principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    fence?: ChangeFence,
  ): Promise<PublishPreview>;
  publishDraft(
    principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    opts: PublishOptions,
    fence?: ChangeFence,
  ): Promise<PublishResult>;
  undoTo(
    principal: ChangePrincipal,
    live: AppHost,
    version: number,
    opts: { author: string; from?: number },
    fence?: ChangeFence,
  ): Promise<ExecuteResult>;
  /** A fresh fork from live with `commands` replayed in order. Live is only read. */
  rebuild(
    principal: ChangePrincipal,
    live: AppHost,
    input: RebuildInput,
    fence?: ChangeFence,
  ): Promise<RebuildResult>;
  /** Rehearse the draft on a fresh copy of current live data and name what blocks Apply. */
  checkBatch(
    principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    fence?: ChangeFence,
  ): Promise<BatchCheck>;
  /**
   * Take an applied batch back off with `undoTo`. Archived values come back;
   * records added since Apply stay. Live must not be frozen.
   */
  undoBatch(
    principal: ChangePrincipal,
    live: AppHost,
    input: UndoBatchInput,
    fence?: ChangeFence,
  ): Promise<ChangeResult>;
}

/** Identity of what Apply would do: the engine digest plus the ordered active (card, revision) pairs. */
export function batchDigest(
  engineDigest: string,
  cards: { id: string; revision: number }[],
): string {
  return createHash('sha256')
    .update(canonical({ engine: engineDigest, cards }))
    .digest('hex');
}

// ---------- checks that need only the chain ----------

/** Columns a step changes in place (a rename touches both names). */
function touched(step: Step): { table: string; column: string }[] {
  switch (step.op) {
    case 'renameColumn':
      return [
        { table: step.table, column: step.from },
        { table: step.table, column: step.to },
      ];
    case 'dropColumn':
    case 'convertColumn':
    case 'calculation':
      return [{ table: step.table, column: step.column }];
    default:
      return [];
  }
}

/**
 * Blockers readable from the draft's versions alone: a report that names a
 * field its source model no longer has, and one field changed by steps of two
 * different versions.
 */
export function findChainBlockers(chain: DraftChain): BatchBlocker[] {
  const out: BatchBlocker[] = [];
  chain.versions.forEach((rec) => {
    for (const e of validate(rec.definition)) {
      const m = /^report ([^:]+): unknown field (.+)$/.exec(e);
      if (m)
        out.push({
          code: 'report_uses_removed_field',
          versions: [rec.version],
          message: `The report "${m[1]}" uses the field "${m[2]}", which these changes remove.`,
        });
    }
  });
  const seen = new Map<string, Set<number>>();
  const numberOf = new Map<number, number>();
  chain.versions.forEach((rec, i) => {
    numberOf.set(i, rec.version);
    for (const step of rec.migration?.steps ?? [])
      for (const t of touched(step)) {
        const key = `${t.table}.${t.column}`;
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key)?.add(i);
      }
  });
  for (const [field, versions] of seen)
    if (versions.size > 1)
      out.push({
        code: 'same_field_twice',
        field,
        versions: [...versions].map((i) => numberOf.get(i) as number),
        message: `${field} is changed by more than one waiting change. Remove one of them.`,
      });
  return out;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function overwritesOf(preview: PublishPreview | null): BatchOverwrites {
  const dataSteps = (preview?.versions ?? []).flatMap((v) => v.dataSteps ?? []);
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    recordsUpdated: dataSteps
      .filter((s) => s.op === 'loadRecords')
      .reduce((n, s) => n + num(s.counts.update), 0),
    recordsMerged: dataSteps
      .filter((s) => s.op === 'mergeRecords')
      .reduce((n, s) => n + num(s.counts.removed), 0),
    archivedValues: preview?.archives.values ?? 0,
    archivedTables: preview?.archives.tables ?? 0,
    dataSteps,
  };
}

/**
 * The replay failed on one version: say so in plain words and name the
 * version so the caller can find its card. The engine's own text mentions the
 * draft and publishing; none of that reaches the owner.
 */
function replayFailure(raw: string, chain: DraftChain): BatchBlocker {
  const rec = chain.versions.find((r) => raw.startsWith(`"${r.summary}" `));
  const reason = /(?:nothing was published|is invalid): (.+)$/s.exec(raw)?.[1];
  return {
    code: 'replay_failed',
    ...(rec ? { versions: [rec.version] } : {}),
    message: reason
      ? `This change does not fit your current data: ${reason}`
      : 'This change does not fit your current data.',
  };
}

/** The figures a review pins: the overwrite counts only (see `BatchCheck.reviewDigest`). */
function reviewDigestOf(
  liveVersion: number,
  chain: DraftChain,
  preview: PublishPreview,
): string {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const figures = preview.versions.map((v) =>
    (v.dataSteps ?? []).map((s) => ({
      op: s.op,
      model: s.model,
      mode: s.mode ?? null,
      overwrites:
        s.op === 'loadRecords'
          ? num(s.counts.update)
          : s.op === 'mergeRecords'
            ? num(s.counts.removed)
            : 0,
    })),
  );
  return createHash('sha256')
    .update(canonical({ chain: chainDigest(liveVersion, chain), figures }))
    .digest('hex');
}

const sameDefinition = (a: AppDefinition, b: AppDefinition) =>
  canonical(a) === canonical(b);

// ---------- the SQLite adapter ----------

export class SqliteChangeEngine implements ChangeEngine {
  forkDraft(
    _principal: ChangePrincipal,
    live: AppHost,
    draftDir: string,
    opts: ForkDraftOptions,
    _fence?: ChangeFence,
  ) {
    return live.forkDraft(draftDir, opts);
  }

  previewPublish(
    _principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    _fence?: ChangeFence,
  ) {
    return live.previewPublish(draft);
  }

  publishDraft(
    _principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    opts: PublishOptions,
    _fence?: ChangeFence,
  ) {
    return live.publishDraft(draft, opts);
  }

  undoTo(
    _principal: ChangePrincipal,
    live: AppHost,
    version: number,
    opts: { author: string; from?: number },
    _fence?: ChangeFence,
  ) {
    return live.execute(
      { type: 'undoTo', version, from: opts.from },
      { author: opts.author, approved: true },
    );
  }

  async rebuild(
    principal: ChangePrincipal,
    live: AppHost,
    input: RebuildInput,
    fence?: ChangeFence,
  ): Promise<RebuildResult> {
    const draft = await this.forkDraft(
      principal,
      live,
      input.draftDir,
      { store: input.store },
      fence,
    );
    const applied: RebuildResult['applied'] = [];
    const blockers: BatchBlocker[] = [];
    try {
      for (const { key, command } of input.commands) {
        if (input.signal?.aborted)
          throw new EngineError('the rebuild was interrupted', 'refused');
        try {
          // The working copy approves its own risky changes (`autoApprove`,
          // draft hosts only), so no `approved` flag is passed here.
          const r = (await draft.execute(command, {
            author: input.author,
          })) as ChangeResult;
          applied.push({ key, version: r.version });
        } catch (e) {
          if (input.signal?.aborted) throw e;
          blockers.push({
            code: 'depends_on_removed',
            key,
            message: messageOf(e),
          });
        }
      }
      if (input.signal?.aborted)
        throw new EngineError('the rebuild was interrupted', 'refused');
    } catch (e) {
      // Live was only read; throwing the half-built copy away leaves nothing behind.
      await draft.discard().catch(() => {});
      throw e;
    }
    return { draft, applied, blockers };
  }

  async checkBatch(
    principal: ChangePrincipal,
    live: AppHost,
    draft: AppHost,
    fence?: ChangeFence,
  ): Promise<BatchCheck> {
    const chain = await draft.draftChain();
    const blockers: BatchBlocker[] = [];
    if (
      chain.baseVersion !== live.version ||
      !sameDefinition(live.def, chain.base.definition)
    )
      blockers.push({
        code: 'base_moved',
        message: `Your app changed (version ${chain.baseVersion} to ${live.version}) after these changes were started. Discard them and start again.`,
      });
    if (!chain.versions.length)
      return {
        ok: !blockers.length,
        blockers,
        overwrites: overwritesOf(null),
        engineDigest: null,
        reviewDigest: null,
        preview: null,
      };
    blockers.push(...findChainBlockers(chain));
    let preview: PublishPreview | null = null;
    if (!blockers.some((b) => b.code === 'base_moved')) {
      try {
        preview = await this.previewPublish(principal, live, draft, fence);
      } catch (e) {
        if (!(e instanceof EngineError)) throw e;
        if (!blockers.some((b) => b.code === 'report_uses_removed_field'))
          blockers.push(replayFailure(e.message, chain));
      }
    }
    return {
      ok: !blockers.length,
      blockers,
      overwrites: overwritesOf(preview),
      engineDigest: preview?.digest ?? null,
      reviewDigest: preview
        ? reviewDigestOf(live.version, chain, preview)
        : null,
      preview,
    };
  }

  async undoBatch(
    principal: ChangePrincipal,
    live: AppHost,
    input: UndoBatchInput,
    fence?: ChangeFence,
  ): Promise<ChangeResult> {
    const { versions } = input;
    if (!versions.length || !versions.every(Number.isInteger))
      throw new EngineError('undoBatch needs the applied versions', 'refused');
    const history = new Map((await live.versions()).map((v) => [v.version, v]));
    const recs = versions.map((v) => history.get(v));
    if (recs.some((r) => !r))
      throw new EngineError('an applied version is missing', 'not_found');
    const first = recs[0];
    if (
      !first ||
      first.parent === null ||
      recs.some((r, i) => i > 0 && r?.parent !== versions[i - 1])
    )
      throw new EngineError(
        'those versions are not one applied batch',
        'refused',
      );
    if (live.version !== versions[versions.length - 1])
      throw new EngineError(
        `the app has changed since this batch was applied (now at version ${live.version})`,
        'refused',
      );
    // undoTo restores archived values and never touches rows made since; the
    // pre-apply snapshot is deliberately not used (it would lose those rows).
    return (await this.undoTo(
      principal,
      live,
      first.parent,
      { author: input.author, from: live.version },
      fence,
    )) as ChangeResult;
  }
}

export const createSqliteChangeEngine = (): ChangeEngine =>
  new SqliteChangeEngine();
