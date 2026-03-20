<script lang="ts">
import type { ContentContributorData } from '../../mock-smrt-client';

export interface Props {
  contributors?: ContentContributorData[];
  onSave: (contributor: Partial<ContentContributorData>) => void;
  onDelete?: (contributor: ContentContributorData) => void;
}

let { contributors = [], onSave, onDelete = undefined }: Props = $props();

function createDraft(source: Partial<ContentContributorData> = {}) {
  return {
    ...source,
    email: source.email || '',
    name: source.name || '',
    trustLevel: source.trustLevel || 'standard',
  };
}

let editing = $state<Partial<ContentContributorData> | null>(null);
let draft = $state(createDraft());

$effect(() => {
  draft = createDraft(editing || {});
});

function handleSubmit() {
  onSave({
    ...editing,
    email: draft.email,
    name: draft.name,
    trustLevel: draft.trustLevel,
  });
}
</script>

<section class="manager">
  <header>
    <div>
      <h3>Contributors</h3>
      <p>Manage contributor trust levels for intake queue bypass and moderation.</p>
    </div>
    <button type="button" onclick={() => (editing = {})}>Add contributor</button>
  </header>

  <div class="layout">
    <div class="list">
      {#each contributors as contributor (contributor.id ?? contributor.email)}
        <article class="card">
          <div>
            <strong>{contributor.name || contributor.email}</strong>
            <div>{contributor.trustLevel || 'standard'}</div>
          </div>
          <div class="actions">
            <button type="button" class="secondary" onclick={() => (editing = contributor)}>Edit</button>
            {#if onDelete}
              <button type="button" class="danger" onclick={() => onDelete?.(contributor)}>Delete</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <form
      class="editor"
      onsubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <label>
        Email
        <input type="email" bind:value={draft.email} required />
      </label>
      <label>
        Name
        <input type="text" bind:value={draft.name} />
      </label>
      <label>
        Trust level
        <select bind:value={draft.trustLevel}>
          <option value="standard">standard</option>
          <option value="trusted">trusted</option>
          <option value="blocked">blocked</option>
        </select>
      </label>

      <div class="actions">
        <button type="submit">Save contributor</button>
      </div>
    </form>
  </div>
</section>

<style>
  .manager,
  .layout,
  .list,
  .editor {
    display: grid;
    gap: 1rem;
  }

  .layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }

  .card,
  .editor {
    border: 1px solid #d9d9d9;
    border-radius: 0.75rem;
    padding: 0.9rem;
    background: #fff;
  }

  .card,
  .actions,
  header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .editor label {
    display: grid;
    gap: 0.35rem;
  }

  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
