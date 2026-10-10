import type { RecordCommentView } from './RecordComments.svelte';

/** Browser-only sample projections, never persisted or sent as notifications. */
export const recordCommentsDemo: readonly RecordCommentView[] = [
  {
    id: 'demo-comment-1',
    authorLabel: 'Alex',
    body: 'The draft is ready for review.',
  },
  {
    id: 'demo-comment-2',
    authorLabel: 'Sam',
    body: 'I will check it this afternoon.',
  },
];
