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
  /**
   * Produce safe text or an authenticated same-origin URL; never storage keys.
   * `list` calls it for each row's primary part, so it must not read bytes.
   */
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
/**
 * The original a row should preview: the shallowest non-metadata durable part
 * (an upload's file before its capture record, an email's first attachment
 * before the message JSON), falling back to the first part.
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
    (a, b) => depth(a) - depth(b) || a.partId.localeCompare(b.partId),
  );
  return (
    ordered.find((part) => part.mediaType !== 'application/json') ?? ordered[0]
  );
}
function withoutText<T extends { text?: string }>(view: T): Omit<T, 'text'> {
  const { text: _text, ...rest } = view;
  return rest;
}

export function createIntakeReviewHost(
  service: IngestionService,
  options: IntakeReviewHostOptions,
): IntakeReviewHost {
  const label =
    options.label ?? ((item: IntakeItemDTO) => `Intake ${item.id.slice(0, 8)}`);
  const inboxEvidence = async (
    parts: readonly IntakeEvidenceDTO[],
  ): Promise<InboxEvidence | undefined> => {
    const primary = primaryEvidence(parts);
    if (!primary) return undefined;
    return {
      ...withoutText(await options.evidence(primary)),
      evidence: primary,
    };
  };
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
      // One batched evidence read for the page; never one load per row.
      const evidence = await service.listEvidence(
        projected.map((entry) => entry.item.id),
      );
      for (const entry of projected) {
        const primary = await inboxEvidence(evidence.get(entry.item.id) ?? []);
        if (primary) entry.evidence = primary;
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
      await service.getItem(itemId);
      const primary = primaryEvidence(evidence.map((view) => view.evidence));
      const primaryView = evidence.find((view) => view.evidence === primary);
      return {
        entry: {
          item,
          label: label(item),
          state: summary.state,
          assignment,
          ...(primaryView ? { evidence: withoutText(primaryView) } : {}),
        },
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
