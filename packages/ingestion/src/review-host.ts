/** Server-side implementation of the transport-neutral review callback contract. */
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { GenerationAnalysisOutput } from './proposal-dto.js';
import { loadReviewAnalysis } from './review-analysis.js';
import type {
  Assignment,
  EvidenceView,
  InboxEntry,
  IntakeReviewHost,
} from './review-dto.js';
import { loadReviewSummary } from './review-summary.js';
import {
  type IngestionService,
  IntakeScanLimitError,
  ITEM_ID_FILTER_CEILING,
  ITEM_PAGE_CEILING,
  ITEM_SCAN_CEILING,
  isIntakeId,
} from './server.js';

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
  label?(item: IntakeItemDTO): string;
  /** Expose the optional feedback UI only when the service has feedback configured. */
  enableFeedback?: boolean;
  /** Optional wakeup after a durable logical split has queued extraction. */
  onSplit?(itemId: string, revision: number): Promise<void>;
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
    options.label ?? ((item: IntakeItemDTO) => `Intake ${item.id.slice(0, 8)}`);
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
            return { items, ...(cursor ? { nextCursor: cursor } : {}) };
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
          items.push({ item, label: label(item), state, assignment });
          // The continuation is the last row actually returned, so an
          // assignment that changed between the page read and the assignment
          // read can only cost one extra scan, never skip or repeat a row.
          if (items.length === limit)
            return {
              items,
              ...(page.nextCursor || index < page.items.length - 1
                ? { nextCursor: rowCursor }
                : {}),
            };
        }
        if (!page.nextCursor) return { items };
        if (page.items.length < limit || examined >= ITEM_SCAN_CEILING)
          return { items, nextCursor: page.nextCursor };
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
      await service.getItem(itemId);
      return {
        entry: { item, label: label(item), state: summary.state, assignment },
        evidence,
        analysis,
        reviews,
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
        !input.requestId.trim()
      )
        throw new Error('Invalid preview');
      const analysis = await service.getCompletedAnalysis(
        input.itemId,
        input.attemptId,
      );
      const generation = (
        analysis.result.output as unknown as GenerationAnalysisOutput
      ).proposals;
      if (
        analysis.configuration.stage !== 'interpret' ||
        generation?.suggestions[input.index]?.disposition !== 'ready_for_review'
      )
        throw new Error('Preview unavailable');
      const suggestion = generation.suggestions[input.index];
      const handler = generation.offered.find(
        ({ handler }) =>
          handler.id === suggestion.handlerId &&
          handler.version === suggestion.handlerVersion,
      )?.handler;
      if (!handler) throw new Error('Preview unavailable');
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
            if (
              intakeBindingDigest(binding.args) ===
              intakeBindingDigest(suggestion.args)
            )
              return;
          }
          break;
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error('Repeated review cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
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
    ...(options.enableFeedback
      ? {
          feedback: (
            input: Parameters<NonNullable<IntakeReviewHost['feedback']>>[0],
          ) => service.recordFeedback(input),
        }
      : {}),
  };
}
