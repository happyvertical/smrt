<script lang="ts">
export interface RecordCommentView {
  id: string;
  body: string;
  authorLabel: string;
  createdAtLabel?: string;
  parentCommentId?: string | null;
}
export interface Props {
  contextKey: string;
  comments: readonly RecordCommentView[];
  onsubmit?: (body: string) => void | Promise<void>;
  onreply?: (parentCommentId: string, body: string) => void | Promise<void>;
  heading?: string;
}
let {
  contextKey,
  comments,
  onsubmit,
  onreply,
  heading = 'Comments',
}: Props = $props();
const inputId = $props.id();
let generation = 0;
$effect(() => {
  void contextKey;
  generation += 1;
  body = '';
  replyTo = null;
  pending = false;
  error = '';
  return () => {
    generation += 1;
  };
});
let replyTo = $state<string | null>(null);
let body = $state('');
let pending = $state(false);
let error = $state('');
async function submit() {
  if (pending) return;
  const submittedGeneration = generation;
  const value = body.trim();
  if (!value) {
    error = 'Write a comment before posting.';
    return;
  }
  if (replyTo ? !onreply : !onsubmit) return;
  pending = true;
  error = '';
  try {
    if (replyTo && onreply) await onreply(replyTo, value);
    else await onsubmit?.(value);
    if (generation === submittedGeneration) {
      body = '';
      replyTo = null;
    }
  } catch {
    if (generation === submittedGeneration)
      error =
        'Could not confirm your comment was posted. Refresh and check the discussion before posting again.';
  } finally {
    if (generation === submittedGeneration) pending = false;
  }
}
</script>

<section aria-label={heading} class="smrt-record-comments__root" data-smrt-component="RecordComments">
  <h2 data-smrt-part="title">{heading}</h2>
  <ol data-smrt-part="list" aria-live="polite">
    {#each comments as comment (comment.id)}
      <li data-smrt-part="row" data-parent={comment.parentCommentId ?? undefined}><strong>{comment.authorLabel}</strong><p>{comment.body}</p>{#if comment.createdAtLabel}<small>{comment.createdAtLabel}</small>{/if}{#if comment.parentCommentId}<small>Reply to {comments.find(parent => parent.id === comment.parentCommentId)?.authorLabel ?? 'comment'}</small>{/if}{#if onreply}<button type="button" disabled={pending} onclick={() => { replyTo = comment.id; }}>Reply to {comment.authorLabel}</button>{/if}</li>
    {/each}
  </ol>
  {#if onsubmit || (onreply && replyTo)}
    <form data-smrt-part="body" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      {#if replyTo}<p>Replying to {comments.find(comment => comment.id === replyTo)?.authorLabel ?? 'comment'} <button type="button" disabled={pending} onclick={() => { replyTo = null; }}>Cancel reply</button></p>{/if}
      <label for={inputId}>Add a comment</label>
      <textarea id={inputId} bind:value={body} disabled={pending}></textarea>
      {#if error}<p role="alert">{error}</p>{/if}
      <button disabled={pending} type="submit">{pending ? 'Posting…' : 'Post comment'}</button>
    </form>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-record-comments__root {
    display: grid;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  ol {
    display: grid;
    gap: var(--smrt-spacing-3, 0.75rem);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  textarea {
    display: block;
    min-height: 5rem;
    width: 100%;
  }
}

@layer smrt.theme {
  li {
    border-block-end: 1px solid var(--smrt-color-on-surface-variant);
  }
}

</style>
