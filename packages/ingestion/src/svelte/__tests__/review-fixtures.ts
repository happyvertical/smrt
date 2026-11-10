import { vi } from 'vitest';
import type {
  InboxEntry,
  IntakeReviewHost,
  ItemReviewView,
} from '../../review-dto.js';

/** A listed row; `processing` marks a stage in flight. */
export function entry(
  id: string,
  state: InboxEntry['state'] = 'unresolved',
): InboxEntry {
  return {
    item: {
      id,
      receiptState: 'ready',
      processingState: state === 'processing' ? 'running' : 'completed',
      analysisRevision: 1,
      cancelled: false,
      traceId: `trace-${id}`,
    },
    label: `Row ${id}`,
    state,
    assignment: { assigneeId: null, version: 0 },
  };
}
/** An available review view with one completed generation (no suggestions). */
export function view(
  id = 'item',
  state: InboxEntry['state'] = 'unresolved',
): ItemReviewView {
  return {
    entry: entry(id, state),
    availability: 'available',
    evidence: [],
    reviews: { actions: [] },
    analysis: {
      itemId: id,
      attemptId: 'generation-attempt',
      revision: 3,
      inputDigest: 'in',
      outputDigest: 'out',
      evidenceDigest: 'evidence',
      configuration: {},
      evidence: [],
      result: {
        status: 'completed',
        provider: 'fixture',
        model: 'fixture',
        version: '1',
        output: {},
        usage: {},
      },
    },
    generation: {
      version: 1,
      outcome: 'proposals',
      suggestions: [],
      splits: [],
      warnings: [],
      omittedSuggestions: 0,
      source: {
        attemptId: 'extraction-attempt',
        revision: 2,
        inputDigest: 'in',
        outputDigest: 'out',
        evidenceDigest: 'evidence',
      },
      offered: [],
      provenance: {
        configurationVersion: '1',
        promptVersion: '1',
        catalogDigest: 'catalog',
        policyVersions: [],
        generative: { provider: 'fixture', model: 'fixture', version: '1' },
        decision: { configured: false },
        usage: {},
      },
      automaticActionEligible: false,
    },
  };
}
/** Host callbacks answering `load` with a fresh copy of `current()`. */
export function host(
  current: () => ItemReviewView = () => view(),
  extra: Partial<IntakeReviewHost> = {},
): IntakeReviewHost {
  return {
    list: vi.fn(async () => ({ items: [current().entry] })),
    load: vi.fn(async () => structuredClone(current())),
    upload: vi.fn(async () => ({ itemId: 'uploaded' })),
    preview: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    apply: vi.fn(async () => ({
      actionId: 'action',
      state: 'succeeded' as const,
    })),
    candidates: vi.fn(async () => ({ items: [], truncated: false })),
    assign: vi.fn(async () => {}),
    split: vi.fn(async () => {}),
    ...extra,
  };
}
