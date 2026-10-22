/** Server-side implementation of the transport-neutral review callback contract. */
import type { IntakeEvidenceDTO, IntakeItemDTO } from './dto.js';
import type { GenerationAnalysisOutput } from './proposal-dto.js';
import { loadReviewAnalysis } from './review-analysis.js';
import type {
  Assignment,
  EvidenceView,
  InboxEntry,
  IntakeReviewHost,
  ItemReviewView,
} from './review-dto.js';
import { loadReviewSummary } from './review-summary.js';
import type { IngestionService } from './server.js';

/** Trusted application adapters, bound to the same authenticated session as service. */
export interface IntakeReviewHostOptions {
  /** Authenticate receipt, enforce upload limits, and request the first extraction. */
  upload: IntakeReviewHost['upload'];
  /** Read durable assignment state; assignment never grants ingestion permissions. */
  assignment(itemId: string): Promise<Assignment>;
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
  const entry = async (item: IntakeItemDTO): Promise<InboxEntry> => {
    const { state } = await loadReviewSummary(service, item);
    const assignment = await options.assignment(item.id);
    await service.getItem(item.id);
    return { item, label: label(item), state, assignment };
  };
  return {
    async list(input) {
      const items = (await service.listItems())
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((item) => !input.cursor || item.id > input.cursor)
        .slice(0, 21);
      const projected: InboxEntry[] = [];
      for (const item of items.slice(0, 20)) {
        const current = await entry(item);
        if (
          (!input.state || current.state === input.state) &&
          (!input.assigneeId ||
            current.assignment.assigneeId === input.assigneeId)
        )
          projected.push(current);
      }
      return {
        items: projected,
        ...(items.length > 20 ? { nextCursor: items[19].id } : {}),
      };
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
      await service.getItem(itemId);
      return {
        entry: { item, label: label(item), state: summary.state, assignment },
        evidence,
        analysis,
        ...(catalog ? { catalog } : {}),
        ...(disposition ? { disposition } : {}),
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
    async startAction(input) {
      await service.startReviewerAction(input);
    },
    async resolve(input) {
      await service.resolveItem(input);
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
