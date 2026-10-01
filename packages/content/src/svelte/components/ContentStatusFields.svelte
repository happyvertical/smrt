<script lang="ts">
import { FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.editor.js';
import {
  type ContentFieldMode,
  type ContentStatusFieldName,
  FULL_STATUS_FIELDS,
  resolveContentFields,
  SIMPLE_STATUS_FIELDS,
} from './content-field-mode.js';

const { t } = useI18n();

export interface ContentStatusFieldData {
  type?: string;
  state?: string;
  status?: string;
  publish_date?: string;
  [key: string]: unknown;
}

export interface Props {
  /** Current status field values. */
  data: ContentStatusFieldData;
  /**
   * `full` (default) shows Type, State, Status and Published; `simple` shows
   * Status and an optional Publish date with plain labels.
   */
  mode?: ContentFieldMode;
  /** Explicit allow-list of fields; overrides the mode's choice. */
  fields?: readonly ContentStatusFieldName[];
  /** Prefix for field DOM ids, unique per editor on the page (default `content`). */
  idPrefix?: string;
  /** Invoked when the user modifies any status field. */
  onChange?: (change: Record<string, unknown>) => void;
}

let {
  data,
  mode = 'full',
  fields = undefined,
  idPrefix = 'content',
  onChange = undefined,
}: Props = $props();

const simple = $derived(mode === 'simple');
const shown = $derived(
  resolveContentFields(mode, fields, SIMPLE_STATUS_FIELDS, FULL_STATUS_FIELDS),
);
const publishLabel = $derived(
  simple
    ? t(M['content.content_fields.optional'], {
        label: t(M['content.content_fields.publish_date']),
      })
    : t(M['content.content_fields.published']),
);

function updateField(key: string, value: unknown) {
  onChange?.({ [key]: value });
}
</script>

<div class="content-status-fields" class:simple>
  {#if shown.has('type')}
    <FormGroup label={t(M['content.content_fields.type'])} id="{idPrefix}-type">
      <Select name="type" value={data.type || 'article'} onchange={(event) => updateField('type', event.currentTarget.value)}>
        <option value="article">Article</option>
        <option value="document">Document</option>
        <option value="mirror">Mirror</option>
        <option value="video-segment">{t(M['content.content_status_fields.video_segment'])}</option>
      </Select>
    </FormGroup>
  {/if}
  {#if shown.has('state')}
    <FormGroup label={t(M['content.content_fields.state'])} id="{idPrefix}-state">
      <Select name="state" value={data.state || 'active'} onchange={(event) => updateField('state', event.currentTarget.value)}>
        <option value="active">Active</option>
        <option value="highlighted">Highlighted</option>
        <option value="deprecated">Deprecated</option>
      </Select>
    </FormGroup>
  {/if}
  {#if shown.has('status')}
    <FormGroup label={t(M['content.content_fields.status'])} id="{idPrefix}-status">
      <Select name="status" value={data.status || 'draft'} onchange={(event) => updateField('status', event.currentTarget.value)}>
        <option value="draft">{t(M['content.content_fields.status_draft'])}</option>
        <option value="review">{t(M['content.content_fields.status_review'])}</option>
        <option value="published">{t(M['content.content_fields.status_published'])}</option>
        <option value="archived">{t(M['content.content_fields.status_archived'])}</option>
      </Select>
    </FormGroup>
  {/if}
  {#if shown.has('publish_date')}
    <FormGroup label={publishLabel} id="{idPrefix}-publish-date">
      <Input
        name="publish_date"
        type="datetime-local"
        value={data.publish_date || ''}
        onchange={(event) => updateField('publish_date', event.currentTarget.value)}
      />
    </FormGroup>
  {/if}
</div>

<style>
  .content-status-fields {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .content-status-fields :global(.form-group) {
    display: grid;
    gap: 0.35rem;
    min-width: 8.5rem;
    margin: 0;
  }

  .content-status-fields :global(.form-label) {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .content-status-fields.simple :global(.form-label) {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
</style>
