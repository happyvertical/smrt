import type { ChangeCardView, ChangesState } from '../lib/ui/types.ts';

export function card(over: Partial<ChangeCardView> = {}): ChangeCardView {
  return {
    id: 'c1',
    position: 0,
    group: '',
    source: 'assistant',
    summary: 'Add field Fulfillment to Orders',
    status: 'active',
    revision: 1,
    opaque: false,
    commands: [
      {
        type: 'addField',
        model: 'Order',
        field: 'fulfillment',
        definition: {
          type: 'choice',
          label: 'Fulfillment',
          choices: ['Pickup', 'Delivery'],
        },
      },
    ],
    checks: [],
    questions: [],
    comments: [],
    revising: false,
    threadId: '',
    messageId: '',
    editable: true,
    ...over,
  };
}

export function changes(over: Partial<ChangesState> = {}): ChangesState {
  const cards = over.cards ?? [
    card(),
    card({
      id: 'c2',
      position: 1,
      summary: 'New report Orders by fulfillment',
      commands: [{ type: 'defineReport', name: 'r', definition: {} }],
    }),
  ];
  const count = cards.filter((c) => c.status === 'active').length;
  return {
    batchId: 'b1',
    status: 'open',
    count,
    generation: 3,
    digest: 'digest-1',
    checkState: 'ok',
    canApply: true,
    applyNow: false,
    blockers: [],
    overwrites: {
      recordsUpdated: 0,
      recordsMerged: 0,
      archivedValues: 0,
      archivedTables: 0,
    },
    held: null,
    liveVersion: 4,
    baseVersion: 4,
    cards,
    discarded: null,
    lastApplied: null,
    ...over,
  };
}

export const noChanges = (over: Partial<ChangesState> = {}): ChangesState =>
  changes({
    batchId: null,
    status: 'none',
    count: 0,
    digest: '',
    checkState: 'none',
    canApply: false,
    applyNow: false,
    cards: [],
    ...over,
  });
