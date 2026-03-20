<script lang="ts">
import type {
  ContentContributionData,
  ContentContributionTypeData,
} from '../../mock-smrt-client';

export interface ContentContributionFormSubmitData {
  typeKey: string;
  contributorEmail?: string;
  contributorName?: string;
  title: string;
  description: string;
  body: string;
  files: File[];
}

export interface Props {
  types?: ContentContributionTypeData[];
  initial?: Partial<ContentContributionData>;
  showContributorFields?: boolean;
  submitLabel?: string;
  onSubmit: (payload: ContentContributionFormSubmitData) => void;
  onCancel?: () => void;
}

let {
  types = [],
  initial = {},
  showContributorFields = true,
  submitLabel = 'Submit contribution',
  onSubmit,
  onCancel = undefined,
}: Props = $props();

function createDraft(
  source: Partial<ContentContributionData>,
  availableTypes: ContentContributionTypeData[],
) {
  return {
    typeKey: source.contributionTypeKey || availableTypes[0]?.key || '',
    contributorEmail: source.contributorEmail || '',
    contributorName: source.contributorName || '',
    title: source.title || '',
    description: source.description || '',
    body: source.body || '',
    files: [] as File[],
  };
}

function getInitialSignature(source: Partial<ContentContributionData>) {
  return JSON.stringify({
    contributionTypeKey: source.contributionTypeKey || '',
    contributorEmail: source.contributorEmail || '',
    contributorName: source.contributorName || '',
    title: source.title || '',
    description: source.description || '',
    body: source.body || '',
  });
}

let draft = $state(createDraft({}, []));
let lastInitialSignature = $state('__unset__');

$effect(() => {
  const nextInitialSignature = getInitialSignature(initial);
  if (nextInitialSignature !== lastInitialSignature) {
    draft = createDraft(initial, types);
    lastInitialSignature = nextInitialSignature;
    return;
  }

  if (types.length === 0) {
    if (draft.typeKey) {
      draft.typeKey = '';
    }
    return;
  }

  const hasValidType = types.some((type) => type.key === draft.typeKey);
  if (!hasValidType) {
    draft.typeKey = types[0]?.key || '';
  }
});

const activeType = $derived(
  types.find((type) => type.key === draft.typeKey) || null,
);

function handleFileChange(event: Event) {
  const target = event.currentTarget as HTMLInputElement;
  draft.files = Array.from(target.files || []);
}

function handleSubmit() {
  onSubmit({
    typeKey: draft.typeKey,
    contributorEmail: draft.contributorEmail || undefined,
    contributorName: draft.contributorName || undefined,
    title: draft.title,
    description: draft.description,
    body: draft.body,
    files: draft.files,
  });
}
</script>

<form
  class="contribution-form"
  onsubmit={(event) => {
    event.preventDefault();
    handleSubmit();
  }}
>
  <h3>Submit a contribution</h3>

  <label>
    Contribution type
    <select bind:value={draft.typeKey} required>
      {#each types.filter((type) => type.enabled !== false) as type (type.key)}
        <option value={type.key}>{type.label}</option>
      {/each}
    </select>
  </label>

  {#if showContributorFields}
    <div class="grid">
      <label>
        Email
        <input type="email" bind:value={draft.contributorEmail} required />
      </label>
      <label>
        Name
        <input type="text" bind:value={draft.contributorName} />
      </label>
    </div>
  {/if}

  <label>
    Title
    <input type="text" bind:value={draft.title} />
  </label>

  <label>
    Description
    <textarea bind:value={draft.description} rows="2"></textarea>
  </label>

  <label>
    Body
    <textarea bind:value={draft.body} rows="8"></textarea>
  </label>

  {#if activeType?.allowFiles !== false}
    <label>
      Attach files
      <input
        type="file"
        multiple
        onchange={handleFileChange}
      />
    </label>
    {#if draft.files.length > 0}
      <div class="file-list">
        {#each draft.files as file (file.name + file.size)}
          <span>{file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)</span>
        {/each}
      </div>
    {/if}
  {/if}

  <div class="actions">
    <button type="submit">{submitLabel}</button>
    {#if onCancel}
      <button type="button" class="secondary" onclick={() => onCancel?.()}>
        Cancel
      </button>
    {/if}
  </div>
</form>

<style>
  .contribution-form {
    display: grid;
    gap: 0.85rem;
  }

  .grid {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  }

  label {
    display: grid;
    gap: 0.35rem;
  }

  .file-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.9rem;
    color: #555;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
</style>
