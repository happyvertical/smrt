<script lang="ts">
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentContributorData } from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

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
      <p>{t(M['content.contributor_manager.intro'])}</p>
    </div>
    <Button variant="ghost" type="button" onclick={() => (editing = {})}>{t(M['content.contributor_manager.add_contributor'])}</Button>
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
            <Button variant="secondary" type="button" onclick={() => (editing = contributor)}>Edit</Button>
            {#if onDelete}
              <Button variant="danger" type="button" onclick={() => onDelete?.(contributor)}>Delete</Button>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <div class="editor-shell">
      <Form
        class="editor"
        onsubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <label>
          Email
          <Input type="email" bind:value={draft.email} required />
        </label>
        <label>
          Name
          <Input type="text" bind:value={draft.name} />
        </label>
        <label>
          {t(M['content.contributor_manager.trust_level'])}
          <Select bind:value={draft.trustLevel}>
            <option value="standard">standard</option>
            <option value="trusted">trusted</option>
            <option value="blocked">blocked</option>
          </Select>
        </label>

        <div class="actions">
          <Button variant="primary" type="submit">{t(M['content.contributor_manager.save_contributor'])}</Button>
        </div>
      </Form>
    </div>
  </div>
</section>

<style>
  .manager,
  .layout,
  .list,
  .editor-shell :global(.editor) {
    display: grid;
    gap: 1rem;
  }

  .layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }

  .card,
  .editor-shell :global(.editor) {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.9rem;
    background: var(--smrt-color-surface);
  }

  .card,
  .actions,
  header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .editor-shell label {
    display: grid;
    gap: 0.35rem;
  }

  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
