<script lang="ts">
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  ContentContributionData,
  ContentContributionTypeData,
} from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

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
  action?: string;
  onSubmit?: (payload: ContentContributionFormSubmitData) => void;
  onCancel?: () => void;
}

let {
  types = [],
  initial = {},
  showContributorFields = true,
  submitLabel = 'Submit contribution',
  action = undefined,
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

function handleSubmit(event: SubmitEvent) {
  if (!onSubmit) {
    if (!action?.trim()) {
      event.preventDefault();
    }
    return;
  }

  event.preventDefault();
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

<div class="contribution-form-shell">
  <Form
    class="contribution-form"
    method="post"
    enctype="multipart/form-data"
    {action}
    preventDefault={false}
    onsubmit={handleSubmit}
  >
    <h3>{t(M['content.contribution_form.heading'])}</h3>

    <label>
      {t(M['content.contribution_form.contribution_type'])}
      <Select name="typeKey" bind:value={draft.typeKey} required>
        {#each types.filter((type) => type.enabled !== false) as type (type.key)}
          <option value={type.key}>{type.label}</option>
        {/each}
      </Select>
    </label>

    {#if showContributorFields}
      <div class="grid">
        <label>
          Email
          <Input name="contributorEmail" type="email" bind:value={draft.contributorEmail} required />
        </label>
        <label>
          Name
          <Input name="contributorName" type="text" bind:value={draft.contributorName} />
        </label>
      </div>
    {/if}

    <label>
      Title
      <Input name="title" type="text" bind:value={draft.title} />
    </label>

    <label>
      Description
      <Textarea name="description" bind:value={draft.description} rows={2}></Textarea>
    </label>

    <label>
      Body
      <Textarea name="body" bind:value={draft.body} rows={8}></Textarea>
    </label>

    {#if activeType?.allowFiles !== false}
      <label>
        {t(M['content.contribution_form.attach_files'])}
        <!-- raw-primitive-allow: native file input — the Input primitive binds value, which is invalid for type=file (throws InvalidStateError on the bind write-back) and renders a visible control; a file picker stays native -->
        <input
          name="files"
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
      <Button variant="primary" type="submit">{submitLabel}</Button>
      {#if onCancel}
        <Button variant="secondary" type="button" onclick={() => onCancel?.()}>
          Cancel
        </Button>
      {/if}
    </div>
  </Form>
</div>

<style>
  .contribution-form-shell :global(.contribution-form) {
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
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
</style>
