<script lang="ts">
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  data: Record<string, any>;
  onChange?: (change: Record<string, unknown>) => void;
}

let { data, onChange = undefined }: Props = $props();

function updateField(key: string, value: unknown) {
  onChange?.({ [key]: value });
}
</script>

<div class="content-status-fields">
  <label>
    <span>Type</span>
    <Select value={data.type || 'article'} onchange={(event) => updateField('type', event.currentTarget.value)}>
      <option value="article">Article</option>
      <option value="document">Document</option>
      <option value="mirror">Mirror</option>
      <option value="video-segment">{t(M['content.content_status_fields.video_segment'])}</option>
    </Select>
  </label>
  <label>
    <span>State</span>
    <Select value={data.state || 'active'} onchange={(event) => updateField('state', event.currentTarget.value)}>
      <option value="active">Active</option>
      <option value="highlighted">Highlighted</option>
      <option value="deprecated">Deprecated</option>
    </Select>
  </label>
  <label>
    <span>Status</span>
    <Select value={data.status || 'draft'} onchange={(event) => updateField('status', event.currentTarget.value)}>
      <option value="draft">Draft</option>
      <option value="review">Review</option>
      <option value="published">Published</option>
      <option value="archived">Archived</option>
    </Select>
  </label>
  <label>
    <span>Published</span>
    <Input
      type="datetime-local"
      value={data.publish_date || ''}
      onchange={(event) => updateField('publish_date', event.currentTarget.value)}
    />
  </label>
</div>

<style>
  .content-status-fields {
    display: flex;
    align-items: end;
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    min-width: 8.5rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

</style>
