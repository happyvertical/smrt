<script lang="ts">
export interface Props {
  data: Record<string, any>;
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
    <input
      type="text"
      value={data.author || ''}
      oninput={(event) => updateField('author', event.currentTarget.value)}
    />
  </label>
  <label>
    <span>Description</span>
    <textarea
      rows="4"
      value={data.description || ''}
      oninput={(event) => updateField('description', event.currentTarget.value)}
    ></textarea>
  </label>
  <label>
    <span>Tags</span>
    <input
      type="text"
      value={tagsValue}
      placeholder="e.g. news, tech"
      oninput={(event) => updateTags(event.currentTarget.value)}
    />
  </label>
  <label>
    <span>URL</span>
    <input
      type="url"
      value={data.url || ''}
      oninput={(event) => updateField('url', event.currentTarget.value)}
    />
  </label>
  <label>
    <span>File Key</span>
    <input
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

  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid color-mix(in srgb, var(--smrt-color-outline) 50%, transparent);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font: inherit;
    padding: 0.75rem 0.875rem;
  }

  textarea {
    min-height: 7rem;
    resize: vertical;
  }
</style>
