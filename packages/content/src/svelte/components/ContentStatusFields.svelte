<script lang="ts">
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
    <select value={data.type || 'article'} onchange={(event) => updateField('type', event.currentTarget.value)}>
      <option value="article">Article</option>
      <option value="document">Document</option>
      <option value="mirror">Mirror</option>
      <option value="video-segment">Video Segment</option>
    </select>
  </label>
  <label>
    <span>State</span>
    <select value={data.state || 'active'} onchange={(event) => updateField('state', event.currentTarget.value)}>
      <option value="active">Active</option>
      <option value="highlighted">Highlighted</option>
      <option value="deprecated">Deprecated</option>
    </select>
  </label>
  <label>
    <span>Status</span>
    <select value={data.status || 'draft'} onchange={(event) => updateField('status', event.currentTarget.value)}>
      <option value="draft">Draft</option>
      <option value="review">Review</option>
      <option value="published">Published</option>
      <option value="archived">Archived</option>
    </select>
  </label>
  <label>
    <span>Published</span>
    <input
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
    font-size: 0.75rem;
    font-weight: 600;
  }

  select,
  input {
    min-height: 2.5rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 50%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.55rem 0.75rem;
  }
</style>
