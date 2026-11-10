<script lang="ts">
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentContributorData } from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

export interface Props {
  /** List of approved contributors and their trust levels. */
  contributors?: ContentContributorData[];
  /** Fired when the user saves a new or edited contributor. */
  onSave: (contributor: Partial<ContentContributorData>) => void;
  /** Fired when the user removes a contributor. */
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

<section class="smrt-content-contributor-manager__root" data-smrt-component="ContentContributorManager">
  <header>
    <div>
      <h3>Contributors</h3>
      <p>{t(M['content.contributor_manager.intro'])}</p>
    </div>
    <Button variant="ghost" type="button" onclick={() => (editing = {})}>{t(M['content.contributor_manager.add_contributor'])}</Button>
  </header>

  <div class="smrt-content-contributor-manager__layout" data-smrt-part="layout">
    <div class="smrt-content-contributor-manager__list" data-smrt-part="list">
      {#each contributors as contributor (contributor.id ?? contributor.email)}
        <article class="smrt-content-contributor-manager__card" data-smrt-part="item">
          <div>
            <strong>{contributor.name || contributor.email}</strong>
            <div>{contributor.trustLevel || 'standard'}</div>
          </div>
          <div class="smrt-content-contributor-manager__actions" data-smrt-part="actions">
            <Button variant="secondary" type="button" onclick={() => (editing = contributor)}>Edit</Button>
            {#if onDelete}
              <Button variant="danger" type="button" onclick={() => onDelete?.(contributor)}>Delete</Button>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <div class="smrt-content-contributor-manager__editor-shell" data-smrt-part="panel">
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

        <div class="smrt-content-contributor-manager__actions" data-smrt-part="actions">
          <Button variant="primary" type="submit">{t(M['content.contributor_manager.save_contributor'])}</Button>
        </div>
      </Form>
    </div>
  </div>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-contributor-manager__root,
  .smrt-content-contributor-manager__layout,
  .smrt-content-contributor-manager__list,
  .smrt-content-contributor-manager__editor-shell :global(.editor) {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contributor-manager__layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }
  .smrt-content-contributor-manager__card,
  .smrt-content-contributor-manager__editor-shell :global(.editor) {
    padding: 0.9rem;
  }
  .smrt-content-contributor-manager__card,
  .smrt-content-contributor-manager__actions,
  header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .smrt-content-contributor-manager__editor-shell label {
    display: grid;
    gap: 0.35rem;
  }
  @media (max-width: 720px) {
    .smrt-content-contributor-manager__layout {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-content-contributor-manager__card,
  .smrt-content-contributor-manager__editor-shell :global(.editor) {
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
    background: var(--smrt-color-surface);
  }
}

</style>
