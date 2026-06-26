<script lang="ts">
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.editor.js';

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
  data: ContentMetadataFieldData;
  onChange?: (change: Record<string, unknown>) => void;
}

let { data, onChange = undefined }: Props = $props();

const tagsValue = $derived(
  Array.isArray(data.tags) ? data.tags.join(', ') : String(data.tags || ''),
);

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

<div class="content-metadata-fields">
  <label>
    <span>Author</span>
    <Input
      type="text"
      value={data.author || ''}
      oninput={(event) => updateField('author', event.currentTarget.value)}
    />
  </label>
  <label>
    <span>Description</span>
    <Textarea
      rows={4}
      value={data.description || ''}
      oninput={(event) => updateField('description', event.currentTarget.value)}
    ></Textarea>
  </label>
  <label>
    <span>Tags</span>
    <Input
      type="text"
      value={tagsValue}
      placeholder={t(M['content.content_metadata_fields.tags_placeholder'])}
      oninput={(event) => updateTags(event.currentTarget.value)}
    />
  </label>
  <label>
    <span>URL</span>
    <Input
      type="url"
      value={data.url || ''}
      oninput={(event) => updateField('url', event.currentTarget.value)}
    />
  </label>
  <label>
    <span>{t(M['content.content_metadata_fields.file_key'])}</span>
    <Input
      type="text"
      value={data.fileKey || ''}
      oninput={(event) => updateField('fileKey', event.currentTarget.value)}
    />
  </label>
</div>

<style>
  .content-metadata-fields {
    display: grid;
    gap: 1rem;
  }

  label {
    display: grid;
    gap: 0.45rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

</style>
