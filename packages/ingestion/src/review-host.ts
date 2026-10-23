/** Server-side implementation of the transport-neutral review callback contract. */
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { GenerationAnalysisOutput } from './proposal-dto.js';
import { loadReviewAnalysis } from './review-analysis.js';
import type {
  Assignment,
  EvidenceView,
  InboxEntry,
  InboxEvidence,
  IntakeReviewHost,
  ItemReviewView,
} from './review-dto.js';
import { loadInstructionView } from './review-instruction-view.js';
import { loadReviewSummary } from './review-summary.js';
import {
  ReviewerInstructionInvalidError,
  ReviewerInstructionStaleError,
} from './reviewer-instruction.js';
import {
  type IngestionService,
  IntakeScanLimitError,
  ITEM_ID_FILTER_CEILING,
  ITEM_PAGE_CEILING,
  ITEM_SCAN_CEILING,
  isIntakeId,
} from './server.js';

/** One listed row's primary original, as passed to `rowEvidence`. */
export interface RowEvidenceRequest {
  itemId: string;
  evidence: IntakeEvidenceDTO;
}
/** A host's preview for one row: label and same-origin URLs, never text. */
export type RowEvidenceView = Omit<InboxEvidence, 'evidence'>;

/** Trusted application adapters, bound to the same authenticated session as service. */
export interface IntakeReviewHostOptions {
  /** Authenticate receipt, enforce upload limits, and request the first extraction. */
  upload: IntakeReviewHost['upload'];
  /** Read durable assignment state; assignment never grants ingestion permissions. */
  assignment(itemId: string): Promise<Assignment>;
  /**
   * Optional batched assignment read for one inbox page. Missing ids are
   * unassigned at version 0. Without it, `list` calls `assignment` per row.
   */
  assignments?(itemIds: string[]): Promise<Map<string, Assignment>>;
  /**
   * Optional assignee pushdown: the item ids currently assigned to `assigneeId`.
   * `list` restricts the page query to them, so a filtered page is cut in one
   * query. Without it (or beyond ITEM_ID_FILTER_CEILING ids) `list` scans pages
   * and filters by `assignment`, which is still honest but costs more rows.
   */
  assignedItemIds?(assigneeId: string): Promise<string[]>;
  /** Authorize manager/assignee and enforce durable CAS plus request-id replay checks. */
  assign: IntakeReviewHost['assign'];
  /** Produce safe text or an authenticated same-origin URL; never storage keys. */
  evidence(
    evidence: IntakeEvidenceDTO,
  ): Promise<Omit<EvidenceView, 'evidence'>>;
  /**
   * Optional, opt-in row previews for the inbox (#4213). Called at most once
   * per `list` page with each listed row's primary durable part (metadata
   * only, read in one batched query); return item id -> `{ label, viewUrl?,
   * thumbnailUrl? }` built from metadata, without reading bytes. Rows missing
   * from the map get no preview. When omitted, rows show no original link and
   * `list` calls no review-host adapter (`evidence`/`rowEvidence`); it still
   * reads the page's evidence metadata once for filename labels (#4214), for
   * which the host's `authorize` runs once per distinct captured ceiling, and
   * lists with item-only labels if that read fails. If `rowEvidence` throws,
   * the page still lists without previews. `load` never calls it.
   */
  rowEvidence?(
    rows: readonly RowEvidenceRequest[],
  ): Promise<ReadonlyMap<string, RowEvidenceView>>;
  /**
   * Presentation label (#4214). `evidence` is the item's durable parts with
   * the primary part first, so a host can label by the original filename;
   * one-argument implementations keep working. The default is the primary
   * part's own `filename`, else `Intake <8 hex>`.
   */
  label?(item: IntakeItemDTO, evidence: IntakeEvidenceDTO[]): string;
  /** Expose the optional feedback UI only when the service has feedback configured. */
  enableFeedback?: boolean;
  /** Optional wakeup after a durable logical split has queued extraction. */
  onSplit?(itemId: string, revision: number): Promise<void>;
  /** Optional wakeup after a durable reviewer instruction has queued reinterpretation. */
  onInstruct?(itemId: string, revision: number): Promise<void>;
}

/**
 * The original a row should preview, chosen by role rather than media type:
 * when any part has a parent, the record parts (an upload's capture record,
 * an email's message) are skipped and the shallowest child wins (the uploaded
 * file, the first attachment), even when that child is itself JSON. When no
 * part has a parent (a watched-folder file, an email without attachments),
 * the first root part is the original. Ties sort by part id, numerically.
 */
export function primaryEvidence(
  parts: readonly IntakeEvidenceDTO[],
): IntakeEvidenceDTO | undefined {
  const depth = (part: IntakeEvidenceDTO): number => {
    let level = 0;
    let parent = part.parentEvidenceId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      level++;
      parent = parts.find((p) => p.id === parent)?.parentEvidenceId ?? null;
    }
    return level;
  };
  const ordered = [...parts].sort(
    (a, b) =>
      depth(a) - depth(b) ||
      a.partId.localeCompare(b.partId, 'en', { numeric: true }),
  );
  return ordered.find((part) => depth(part) > 0) ?? ordered[0];
}

/**
 * Create callbacks for one authenticated service scope. Create a fresh host when
 * the session changes; HTTP authentication and CSRF remain application duties.
 */
export function createIntakeReviewHost(
  service: IngestionService,
  options: IntakeReviewHostOptions,
): IntakeReviewHost {
  const label =
    options.label ??
    ((item: IntakeItemDTO, evidence: IntakeEvidenceDTO[]) =>
      // The primary part's own name only, never another part's (#4214).
      primaryEvidence(evidence)?.filename ?? `Intake ${item.id.slice(0, 8)}`);
  /** The item's durable parts with the primary part first, for `label`. */
  const labelled = (
    parts: readonly IntakeEvidenceDTO[],
  ): IntakeEvidenceDTO[] => {
    const primary = primaryEvidence(parts);
    return primary
      ? [primary, ...parts.filter((part) => part !== primary)]
      : [...parts];
  };
  /**
   * Label and, when the host opts in, preview a finished page. `list` applies
   * this once to its final entries just before returning, so every return
   * path decorates the same way. It reads the page's evidence metadata in one
   * `listEvidence` query (labels use the original filename, #4214) and calls
   * `rowEvidence` at most once (#4213). Preview fields are picked explicitly
   * so a host value can never put text on a row.
   */
  const decorateRows = async (entries: InboxEntry[]): Promise<InboxEntry[]> => {
    if (!entries.length) return entries;
    let parts: Map<string, IntakeEvidenceDTO[]>;
    try {
      parts = await service.listEvidence(entries.map((entry) => entry.item.id));
    } catch (error) {
      // With `rowEvidence` the host opted into the batched read, so its
      // failure (e.g. a failing authorize) rejects the page, as #4213
      // defines. Without it, this read only improves labels: a host that
      // never asked for evidence keeps listing, labelled as rows without
      // evidence (no filenames), the way `listItems` merely hides rows.
      if (options.rowEvidence) throw error;
      return entries.map((entry) => ({
        ...entry,
        label: label(entry.item, []),
      }));
    }
    const named = entries.map((entry) => ({
      ...entry,
      label: label(entry.item, labelled(parts.get(entry.item.id) ?? [])),
    }));
    if (!options.rowEvidence) return named;
    const rows: RowEvidenceRequest[] = [];
    for (const entry of named) {
      const primary = primaryEvidence(parts.get(entry.item.id) ?? []);
      if (primary) rows.push({ itemId: entry.item.id, evidence: primary });
    }
    if (!rows.length) return named;
    const primaries = new Map(rows.map((row) => [row.itemId, row.evidence]));
    // Everything that touches the host's answer is isolated: a throw, or a
    // malformed answer (not a map, a non-text label), lists without previews
    // rather than rejecting the page.
    try {
      const views = await options.rowEvidence(rows);
      return named.map((entry) => {
        const primary = primaries.get(entry.item.id);
        // Only rows with a durable primary part can carry a preview, even if
        // the host answers for another row.
        if (!primary) return entry;
        const view = views.get(entry.item.id);
        if (!view) return entry;
        if (typeof view.label !== 'string')
          throw new Error('Invalid row evidence');
        const evidence: InboxEvidence = {
          evidence: primary,
          label: view.label,
        };
        if (typeof view.viewUrl === 'string') evidence.viewUrl = view.viewUrl;
        if (typeof view.thumbnailUrl === 'string')
          evidence.thumbnailUrl = view.thumbnailUrl;
        return { ...entry, evidence };
      });
    } catch {
      // A preview failure must not block triage: list without previews.
      return named;
    }
  };
  const assignments = async (
    itemIds: string[],
  ): Promise<Map<string, Assignment>> => {
    if (!itemIds.length) return new Map();
    if (options.assignments) return options.assignments(itemIds);
    const read = new Map<string, Assignment>();
    for (const itemId of itemIds)
      read.set(itemId, await options.assignment(itemId));
    return read;
  };
  return {
    async list(input) {
      // The contract caps `limit` at the service maximum rather than failing.
      const requested = input.limit ?? 20;
      const limit = Number.isNaN(requested)
        ? 20
        : Math.min(ITEM_PAGE_CEILING, Math.max(1, Math.floor(requested)));
      let itemIds: string[] | undefined;
      if (input.assigneeId && options.assignedItemIds) {
        // Junk ids from the host narrow nothing and must not fail the list.
        const assigned = [
          ...new Set(
            (await options.assignedItemIds(input.assigneeId)).filter(
              isIntakeId,
            ),
          ),
        ];
        if (assigned.length <= ITEM_ID_FILTER_CEILING) itemIds = assigned;
      }
      const items: InboxEntry[] = [];
      let cursor = input.cursor;
      let examined = 0;
      // One query per page when every filter is pushed down. Only an
      // assignee filter the host cannot push down scans further pages, and
      // each scan is still one query plus one batched assignment read. A
      // host call never examines more than ITEM_SCAN_CEILING rows: a short
      // service page with a cursor (the service hit its own ceiling) or the
      // host's own count ends the call with that cursor for the caller.
      for (;;) {
        let page: Awaited<ReturnType<IngestionService['listItemsPage']>>;
        try {
          page = await service.listItemsPage({
            limit,
            cursor,
            state: input.state,
            itemIds,
            // The remaining budget: the service never scans past it, so the
            // host's total stays within ITEM_SCAN_CEILING across calls.
            scanLimit: ITEM_SCAN_CEILING - examined,
          });
        } catch (error) {
          // A later call that spent a small remaining budget without
          // returning a row must not discard what earlier calls collected:
          // hand back the position reached so far (a row the actor can read)
          // and let the caller continue.
          if (error instanceof IntakeScanLimitError && cursor !== input.cursor)
            return {
              items: await decorateRows(items),
              ...(cursor ? { nextCursor: cursor } : {}),
            };
          throw error;
        }
        examined += page.scanned;
        const read = await assignments(page.items.map(({ item }) => item.id));
        for (const [
          index,
          { item, state, cursor: rowCursor },
        ] of page.items.entries()) {
          const assignment = read.get(item.id) ?? {
            assigneeId: null,
            version: 0,
          };
          if (input.assigneeId && assignment.assigneeId !== input.assigneeId)
            continue;
          // The label needs the page's evidence; `decorateRows` sets it.
          items.push({ item, label: '', state, assignment });
          // The continuation is the last row actually returned, so an
          // assignment that changed between the page read and the assignment
          // read can only cost one extra scan, never skip or repeat a row.
          if (items.length === limit)
            return {
              items: await decorateRows(items),
              ...(page.nextCursor || index < page.items.length - 1
                ? { nextCursor: rowCursor }
                : {}),
            };
        }
        if (!page.nextCursor) return { items: await decorateRows(items) };
        if (page.items.length < limit || examined >= ITEM_SCAN_CEILING)
          return {
            items: await decorateRows(items),
            nextCursor: page.nextCursor,
          };
        cursor = page.nextCursor;
      }
    },
    async load(itemId, cursor) {
      const item = await service.getItem(itemId);
      const summary = await loadReviewSummary(service, item, cursor);
      const { analysis, reviews } = await loadReviewAnalysis(
        service,
        item,
        summary.reviews,
        cursor,
      );
      const evidence: EvidenceView[] = [];
      for (const part of await service.getEvidence(itemId)) {
        evidence.push({ ...(await options.evidence(part)), evidence: part });
      }
      const assignment = await options.assignment(itemId);
      // The offered catalog lets a reviewer start any handler; it grants nothing.
      // A catalog failure (not configured, bound exceeded, denied) only hides the
      // start-action picker; existing reviews stay reviewable.
      let catalog: ItemReviewView['catalog'];
      try {
        catalog = await service.listHandlers(itemId);
      } catch {
        catalog = undefined;
      }
      // Reviewer and reason come from the review surface, not the item DTO.
      let disposition: ItemReviewView['disposition'];
      if (item.disposition)
        try {
          disposition = await service.getItemDisposition(itemId);
        } catch {
          disposition = undefined;
        }
      const instruction = await loadInstructionView(service, itemId, analysis);
      await service.getItem(itemId);
      return {
        entry: {
          item,
          label: label(item, labelled(evidence.map((view) => view.evidence))),
          state: summary.state,
          assignment,
        },
        evidence,
        analysis,
        ...(catalog ? { catalog } : {}),
        ...(disposition ? { disposition } : {}),
        reviews,
        ...(instruction ? { instruction } : {}),
        availability: 'available',
        ...(analysis?.configuration.stage === 'interpret'
          ? {
              generation: (
                analysis.result.output as unknown as GenerationAnalysisOutput
              ).proposals,
            }
          : {}),
      };
    },
    upload: (files, requestId) => options.upload(files, requestId),
    async preview(input) {
      if (
        !Number.isSafeInteger(input.index) ||
        input.index < 0 ||
        typeof input.attemptId !== 'string' ||
        !input.attemptId ||
        typeof input.requestId !== 'string' ||
        !input.requestId.trim() ||
        (input.args !== undefined &&
          (!input.args ||
            typeof input.args !== 'object' ||
            Array.isArray(input.args)))
      )
        throw new Error('Invalid preview');
      const analysis = await service.getCompletedAnalysis(
        input.itemId,
        input.attemptId,
      );
      const generation = (
        analysis.result.output as unknown as GenerationAnalysisOutput
      ).proposals;
      const suggestion = generation?.suggestions[input.index];
      // A `needs_review` suggestion is previewable by a person (#4208); a failed
      // attempt, a missing handler or a foreign stage still is not.
      if (
        analysis.configuration.stage !== 'interpret' ||
        generation?.outcome === 'provider_error' ||
        !suggestion ||
        !['ready_for_review', 'needs_review'].includes(suggestion.disposition)
      )
        throw new Error('Preview unavailable');
      const handler = generation.offered.find(
        ({ handler }) =>
          handler.id === suggestion.handlerId &&
          handler.version === suggestion.handlerVersion,
      )?.handler;
      if (!handler) throw new Error('Preview unavailable');
      // Human-completed arguments go through the same explicit preview as an
      // edit; they never rewrite the generation snapshot.
      const args = input.args ? structuredClone(input.args) : suggestion.args;
      const intentionKey = `ui:${input.index}`;
      const actionId =
        handler.kind === 'plan'
          ? undefined
          : await service.createAction(input.itemId, intentionKey, {
              origin: 'generated-proposal',
              intentionKey,
            });
      let cursor: string | undefined;
      let expectedRevision = 0;
      const cursors = new Set<string>();
      do {
        const page = await service.listReviews(input.itemId, { cursor });
        const found = page.actions.find((action) =>
          handler.kind === 'plan'
            ? (action.plan?.key ?? action.stalePlan?.key) === intentionKey
            : action.review.actionId === actionId,
        );
        if (found) {
          const binding = handler.kind === 'plan' ? found.plan : found;
          expectedRevision =
            handler.kind === 'plan'
              ? (found.plan?.revision ?? found.stalePlan?.revision ?? 0)
              : found.review.revision;
          // Preparing an unchanged, currently authorized suggestion is idempotent.
          // State-only stale entries never satisfy this shortcut.
          if (
            binding?.attemptId === input.attemptId &&
            binding.handlerId === suggestion.handlerId &&
            binding.handlerVersion === suggestion.handlerVersion &&
            binding.args
          ) {
            const { intakeBindingDigest } = await import('./execution.js');
            if (intakeBindingDigest(binding.args) === intakeBindingDigest(args))
              return;
          }
          break;
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error('Repeated review cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // Every failure throws, as on main. A handler's refusal of the
      // arguments throws `HandlerArgumentsInvalidError`; a transport that
      // preserves its `name` lets the component keep the draft inline.
      if (input.args) {
        const shared = {
          itemId: input.itemId,
          attemptId: input.attemptId,
          expectedRevision,
          requestId: input.requestId,
          handlerId: suggestion.handlerId,
          handlerVersion: suggestion.handlerVersion,
          args,
        };
        if (handler.kind === 'plan')
          await service.previewPlan({ ...shared, planKey: intentionKey });
        else if (actionId)
          await service.previewProposal({ ...shared, actionId });
        return;
      }
      await service.previewGeneratedProposals({
        itemId: input.itemId,
        attemptId: input.attemptId,
        selections: [
          {
            index: input.index,
            intentionKey,
            expectedRevision,
            requestId: input.requestId,
          },
        ],
      });
    },
    async decide(input) {
      await service.submitDecision(input);
    },
    apply: (actionId) => service.applyAction(actionId),
    async editPlan(input) {
      await service.previewPlan(input);
    },
    async editAction(input) {
      await service.previewProposal(input);
    },
    candidates: (input) => service.findCandidates(input),
    async assign(input) {
      await service.getItem(input.itemId);
      await options.assign(input);
    },
    async split(input) {
      const result = await service.reviseLogicalSplit(input);
      await options.onSplit?.(input.itemId, result.revision);
    },
    async startAction(input) {
      await service.startReviewerAction(input);
    },
    async resolve(input) {
      await service.resolveItem(input);
    },
    async instruct(input) {
      // Durable first; the reinterpretation runs through the normal dispatch path.
      let result: Awaited<ReturnType<typeof service.recordReviewerInstruction>>;
      try {
        result = await service.recordReviewerInstruction(input);
      } catch (error) {
        if (error instanceof ReviewerInstructionStaleError)
          return { stale: true as const };
        if (error instanceof ReviewerInstructionInvalidError)
          return { invalid: true as const };
        throw error;
      }
      await options.onInstruct?.(input.itemId, result.revision);
    },
    ...(options.enableFeedback
      ? {
          feedback: (
            input: Parameters<NonNullable<IntakeReviewHost['feedback']>>[0],
          ) => service.recordFeedback(input),
        }
      : {}),
  };
}
