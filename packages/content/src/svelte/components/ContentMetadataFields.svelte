<script lang="ts">
import { FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.editor.js';
import {
  type ContentFieldMode,
  type ContentMetadataFieldName,
  FULL_METADATA_FIELDS,
  resolveContentFields,
  SIMPLE_METADATA_FIELDS,
} from './content-field-mode.js';

const { t } = useI18n();

export interface ContentMetadataFieldData {
  author?: string;
  description?: string;
  url?: string;
  fileKey?: string;
  tags?: string | string[];
  [key: string]: unknown;
}

export interface Props {
  /** Current metadata field values. */
  data: ContentMetadataFieldData;
  /**
   * `full` (default) shows Author, Description, Tags, URL and File key;
   * `simple` shows Author, Summary and Tags — each marked "(optional)" —
   * inside a collapsed "Details" section.
   */
  mode?: ContentFieldMode;
  /** Explicit allow-list of fields; overrides the mode's choice. */
  fields?: readonly ContentMetadataFieldName[];
  /**
   * Wrap the fields in a "Details" disclosure. Defaults to collapsed in
   * simple mode and off in full mode. Pass `{ open: true }` to start open,
   * or `false` when the page supplies its own section.
   */
  details?: boolean | { open?: boolean; label?: string };
  /** Prefix for field DOM ids, unique per editor on the page (default `content`). */
  idPrefix?: string;
  /** Invoked when the user modifies any metadata field. */
  onChange?: (change: Record<string, unknown>) => void;
}

let {
  data,
  mode = 'full',
  fields = undefined,
  details = undefined,
  idPrefix = 'content',
  onChange = undefined,
}: Props = $props();

const simple = $derived(mode === 'simple');
const shown = $derived(
  resolveContentFields(
    mode,
    fields,
    SIMPLE_METADATA_FIELDS,
    FULL_METADATA_FIELDS,
  ),
);
const disclosure = $derived.by(() => {
  const setting = details ?? simple;
  if (setting === false) return null;
  const options = typeof setting === 'object' ? setting : {};
  return {
    open: options.open ?? false,
    label: options.label ?? t(M['content.content_fields.details']),
  };
});

const tagsValue = $derived(
  Array.isArray(data.tags) ? data.tags.join(', ') : String(data.tags || ''),
);

function fieldLabel(label: string): string {
  return simple ? t(M['content.content_fields.optional'], { label }) : label;
}

function updateField(key: string, value: unknown) {
  onChange?.({ [key]: value });
}

function updateTags(value: string) {
  updateField(
    'tags',
    value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
  );
}
</script>

{#snippet metadataFields()}
  <div class="content-metadata-fields">
    {#if shown.has('author')}
      <FormGroup label={fieldLabel(t(M['content.content_fields.author']))} id="{idPrefix}-author">
        <Input
          name="author"
          type="text"
          value={data.author || ''}
          oninput={(event) => updateField('author', event.currentTarget.value)}
        />
      </FormGroup>
    {/if}
    {#if shown.has('description')}
      <FormGroup
        label={simple
          ? fieldLabel(t(M['content.content_fields.summary']))
          : t(M['content.content_fields.description'])}
        hint={simple ? t(M['content.content_fields.summary_hint']) : undefined}
        id="{idPrefix}-description"
      >
        <Textarea
          name="description"
          rows={simple ? 3 : 4}
          value={data.description || ''}
          oninput={(event) => updateField('description', event.currentTarget.value)}
        ></Textarea>
      </FormGroup>
    {/if}
    {#if shown.has('tags')}
      <FormGroup
        label={fieldLabel(t(M['content.content_fields.tags']))}
        hint={simple ? t(M['content.content_fields.tags_hint']) : undefined}
        id="{idPrefix}-tags"
      >
        <Input
          name="tags"
          type="text"
          value={tagsValue}
          placeholder={t(M['content.content_metadata_fields.tags_placeholder'])}
          oninput={(event) => updateTags(event.currentTarget.value)}
        />
      </FormGroup>
    {/if}
    {#if shown.has('url')}
      <FormGroup label={fieldLabel(t(M['content.content_fields.url']))} id="{idPrefix}-url">
        <Input
          name="url"
          type="url"
          value={data.url || ''}
          oninput={(event) => updateField('url', event.currentTarget.value)}
        />
      </FormGroup>
    {/if}
    {#if shown.has('fileKey')}
      <FormGroup label={fieldLabel(t(M['content.content_metadata_fields.file_key']))} id="{idPrefix}-file-key">
        <Input
          name="fileKey"
          type="text"
          value={data.fileKey || ''}
          oninput={(event) => updateField('fileKey', event.currentTarget.value)}
        />
      </FormGroup>
    {/if}
  </div>
{/snippet}

{#if disclosure}
  <details class="content-metadata-details" open={disclosure.open}>
    <summary>{disclosure.label}</summary>
    {@render metadataFields()}
  </details>
{:else}
  {@render metadataFields()}
{/if}

<style>
  .content-metadata-fields {
    display: grid;
    gap: 1rem;
  }

  .content-metadata-fields :global(.form-group) {
    margin: 0;
  }

  .content-metadata-details > summary {
    cursor: pointer;
    padding-block: 0.5rem;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .content-metadata-details[open] > summary {
    margin-bottom: 0.75rem;
  }
</style>
