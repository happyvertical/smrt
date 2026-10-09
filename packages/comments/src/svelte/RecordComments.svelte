<script lang="ts">
export interface RecordCommentView {
  id: string;
  body: string;
  authorLabel: string;
  createdAtLabel?: string;
}
export interface Props {
  comments: readonly RecordCommentView[];
  onsubmit?: (body: string) => void | Promise<void>;
  heading?: string;
}
let { comments, onsubmit, heading = 'Comments' }: Props = $props();
let body = $state('');
let pending = $state(false);
let error = $state('');
async function submit() {
  const value = body.trim();
  if (!value) {
    error = 'Write a comment before posting.';
    return;
  }
  if (!onsubmit) return;
  pending = true;
  error = '';
  try {
    await onsubmit(value);
    body = '';
  } catch {
    error = 'Could not post your comment. Try again.';
  } finally {
    pending = false;
  }
}
</script>

<section aria-label={heading} class="record-comments">
  <h2>{heading}</h2>
  <ol aria-live="polite">
    {#each comments as comment (comment.id)}
      <li><strong>{comment.authorLabel}</strong><p>{comment.body}</p>{#if comment.createdAtLabel}<small>{comment.createdAtLabel}</small>{/if}</li>
    {/each}
  </ol>
  {#if onsubmit}
    <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label for="record-comment">Add a comment</label>
      <textarea id="record-comment" bind:value={body} disabled={pending}></textarea>
      {#if error}<p role="alert">{error}</p>{/if}
      <button disabled={pending} type="submit">{pending ? 'Posting…' : 'Post comment'}</button>
    </form>
  {/if}
</section>

<style>.record-comments { display: grid; gap: var(--smrt-spacing-3, 0.75rem); } ol { display: grid; gap: var(--smrt-spacing-3, 0.75rem); list-style: none; margin: 0; padding: 0; } li { border-block-end: 1px solid var(--smrt-color-on-surface-variant); } textarea { display: block; min-height: 5rem; width: 100%; }</style>
