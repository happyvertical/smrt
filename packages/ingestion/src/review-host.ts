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
import { loadReviewSummary } from './review-summary.js';
import type { IngestionService } from './server.js';

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
   * from the map get no preview. When omitted, `list` reads no evidence and
   * rows show no original link; if it throws, the page still lists without
   * previews. `load` never calls it.
   */
  rowEvidence?(
    rows: readonly RowEvidenceRequest[],
  ): Promise<ReadonlyMap<string, RowEvidenceView>>;
  label?(item: IntakeItemDTO): string;
  /** Expose the optional feedback UI only when the service has feedback configured. */
  enableFeedback?: boolean;
  /** Optional wakeup after a durable logical split has queued extraction. */
  onSplit?(itemId: string, revision: number): Promise<void>;
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
    options.label ?? ((item: IntakeItemDTO) => `Intake ${item.id.slice(0, 8)}`);
  /**
   * Opt-in row previews for a finished page. `list` applies this once to its
   * final entries just before returning, so every return path decorates the
   * same way. Without `rowEvidence` it makes no read and returns the entries
   * unchanged. Fields are picked explicitly so a host value can never put
   * text on a row.
   */
  const withRowEvidence = async (
    entries: InboxEntry[],
  ): Promise<InboxEntry[]> => {
    if (!options.rowEvidence || !entries.length) return entries;
    const parts = await service.listEvidence(
      entries.map((entry) => entry.item.id),
    );
    const rows: RowEvidenceRequest[] = [];
    for (const entry of entries) {
      const primary = primaryEvidence(parts.get(entry.item.id) ?? []);
      if (primary) rows.push({ itemId: entry.item.id, evidence: primary });
    }
    if (!rows.length) return entries;
    const primaries = new Map(rows.map((row) => [row.itemId, row.evidence]));
    // Everything that touches the host's answer is isolated: a throw, or a
    // malformed answer (not a map, a non-text label), lists without previews
    // rather than rejecting the page.
    try {
      const views = await options.rowEvidence(rows);
      return entries.map((entry) => {
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
      return entries;
    }
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
      return {
        items: await withRowEvidence(projected),
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
