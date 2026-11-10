<script lang="ts">
import { Button, Modal } from '@happyvertical/smrt-ui';
import { goto, invalidateAll } from '$app/navigation';
import { ApiError, api } from '$lib/ui/api';
import type { Description, DraftInfo, Target } from '$lib/ui/types';

let { description }: { description: Description } = $props();
const draft = $derived(description.draft);
let busy = $state(false);
let error = $state('');
let confirming = $state(false);

async function act(operation: 'start' | 'discard' | Target) {
  busy = true;
  error = '';
  try {
    if (operation === 'start') {
      await api<DraftInfo>('/api/shell/draft', { method: 'POST', body: {} });
      await api('/api/shell/draft/view', {
        method: 'PUT',
        body: { view: 'draft' },
      });
    } else if (operation === 'discard') {
      await api('/api/shell/draft/discard', {
        method: 'POST',
        body: { draftId: draft?.id },
      });
      confirming = false;
    } else {
      await api('/api/shell/draft/view', {
        method: 'PUT',
        body: { view: operation },
      });
    }
    // A model/record may only exist in the old copy; home always exists.
    await goto('/', { invalidateAll: true });
    await invalidateAll();
  } catch (e) {
    error = e instanceof ApiError ? e.message : 'Could not update the draft.';
  } finally {
    busy = false;
  }
}
</script>

<div class="draft-header" data-testid="draft-header">
  <div class="draft-bar" aria-label="App copy">
    {#if draft}
      <div class="copy-switch" role="group" aria-label="View copy">
        <Button variant="ghost" aria-pressed={description.mode === 'live'} disabled={busy} onclick={() => act('live')}>Live</Button>
        <div class:active-draft={description.mode === 'draft'}>
          <Button variant="ghost" aria-pressed={description.mode === 'draft'} disabled={busy || !draft.publishable} onclick={() => act('draft')}>Draft</Button>
        </div>
      </div>
      <span>{draft.changes} {draft.changes === 1 ? 'change' : 'changes'}, not published</span>
      <div class="draft-actions">
        <Button variant="secondary" disabled={busy} onclick={() => (confirming = true)}>Discard</Button>
        <Button href="/draft/review" disabled={busy || !draft.publishable}>Review and publish</Button>
      </div>
    {:else}
      <Button variant="ghost" disabled={busy} onclick={() => act('start')}>Start draft</Button>
    {/if}
  </div>
  {#if draft && description.mode === 'draft'}
    <p class="draft-strip" role="note">Draft: a test copy. Records you add here are thrown away when you publish.</p>
  {/if}
  {#if draft && !draft.publishable}
    <p class="draft-strip" role="alert">This draft cannot be published. {draft.problem} Discard it to start again.</p>
  {:else if draft?.recovery === 'rolled-back'}
    <p class="draft-strip" role="status">The last publish was interrupted and taken back. Review the draft and publish again.</p>
  {/if}
  {#if error && !confirming}<p class="sh-alert sh-alert-error" role="alert">{error}</p>{/if}
</div>

<Modal open={confirming} title="Discard this draft?" showClose={false} closeOnEscape={!busy} closeOnBackdrop={!busy} onClose={() => (confirming = false)}>
  <p>Discard “{draft?.name}” and its test records? Your live app stays unchanged.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#snippet footer()}
    <Button variant="secondary" disabled={busy} onclick={() => (confirming = false)}>Cancel</Button>
    <Button variant="danger" disabled={busy} onclick={() => act('discard')}>Discard draft</Button>
  {/snippet}
</Modal>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .draft-header { color: var(--smrt-color-on-surface); }
  .draft-bar, .copy-switch, .draft-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-sm);
  }
  .draft-bar { padding: var(--smrt-spacing-md) var(--smrt-spacing-lg); }
  .draft-actions { margin-inline-start: auto; }
  .copy-switch { border-radius: var(--smrt-radius-md); background: var(--smrt-color-surface-container); }
  .active-draft { border-radius: var(--smrt-radius-md); background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); }
  .copy-switch :global([aria-pressed='true']) { font-weight: var(--smrt-typography-weight-bold); text-decoration: underline; }
  .draft-strip { margin: 0; padding: var(--smrt-spacing-sm) var(--smrt-spacing-lg); background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); }
}
</style>
