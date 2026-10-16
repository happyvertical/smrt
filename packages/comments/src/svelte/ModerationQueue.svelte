<script lang="ts">
export type ModerationStatus = 'visible' | 'hidden' | 'pending' | 'deleted';
export interface ModerationCommentView {
  id: string;
  body: string;
  authorLabel: string;
  status: ModerationStatus;
  reportCount?: number;
}
export interface Props {
  comments: readonly ModerationCommentView[];
  onmoderate?: (
    commentId: string,
    status: ModerationStatus,
  ) => void | Promise<void>;
  heading?: string;
}
let { comments, onmoderate, heading = 'Comment moderation' }: Props = $props();
let pendingId = $state<string | null>(null);
let error = $state('');
async function moderate(commentId: string, status: ModerationStatus) {
  if (!onmoderate || pendingId) return;
  pendingId = commentId;
  error = '';
  try {
    await onmoderate(commentId, status);
  } catch {
    error = 'Could not update this comment. Refresh and try again.';
  } finally {
    pendingId = null;
  }
}
</script>

<section aria-label={heading} class="moderation-queue" data-smrt-component="ModerationQueue">
  <h2>{heading}</h2>
  {#if error}<p role="alert">{error}</p>{/if}
  <ol>
    {#each comments as comment (comment.id)}
      <li>
        <strong>{comment.authorLabel}</strong><p>{comment.body}</p>
        <small>{comment.status}{#if comment.reportCount} · {comment.reportCount} reports{/if}</small>
        {#if onmoderate}
          <div aria-label={`Moderate ${comment.authorLabel}'s comment`}>
            <button disabled={pendingId !== null} onclick={() => void moderate(comment.id, 'visible')}>Approve</button>
            <button disabled={pendingId !== null} onclick={() => void moderate(comment.id, 'hidden')}>Hide</button>
            <button disabled={pendingId !== null} onclick={() => void moderate(comment.id, 'deleted')}>Delete</button>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.moderation-queue { display: grid; gap: var(--smrt-spacing-3, 0.75rem); } ol { display: grid; gap: var(--smrt-spacing-3, 0.75rem); list-style: none; margin: 0; padding: 0; } li { border-block-end: var(--smrt-hairline); } button { margin-inline-end: var(--smrt-spacing-2, 0.5rem); }
}
</style>
