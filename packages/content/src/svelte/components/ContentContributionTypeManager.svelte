<script lang="ts">
import type { ContentContributionTypeData } from '../../mock-smrt-client';

export interface Props {
  types?: ContentContributionTypeData[];
  onSave: (type: Partial<ContentContributionTypeData>) => void;
  onDelete?: (type: ContentContributionTypeData) => void;
}

let { types = [], onSave, onDelete = undefined }: Props = $props();

function createDraft(source: Partial<ContentContributionTypeData> = {}) {
  return {
    ...source,
    key: source.key || '',
    label: source.label || '',
    enabled: source.enabled ?? true,
    allowedChannels: source.allowedChannels || ['web'],
    allowText: source.allowText ?? true,
    allowFiles: source.allowFiles ?? false,
    allowEmptyText: source.allowEmptyText ?? false,
    intakeRules: {
      maxFiles: source.intakeRules?.maxFiles ?? '',
      maxTotalBytes: source.intakeRules?.maxTotalBytes ?? '',
      allowedMimePatterns: (source.intakeRules?.allowedMimePatterns || []).join(
        ', ',
      ),
      blockedMimePatterns: (source.intakeRules?.blockedMimePatterns || []).join(
        ', ',
      ),
      quarantineMimePatterns: (
        source.intakeRules?.quarantineMimePatterns || []
      ).join(', '),
      blockedTextPatterns: (source.intakeRules?.blockedTextPatterns || []).join(
        ', ',
      ),
      quarantineTextPatterns: (
        source.intakeRules?.quarantineTextPatterns || []
      ).join(', '),
      trustedOnly: source.intakeRules?.trustedOnly ?? false,
    },
    promotion: {
      targetContentType: source.promotion?.targetContentType || '',
      targetContentVariant: source.promotion?.targetContentVariant || '',
      targetContentStatus: source.promotion?.targetContentStatus || 'draft',
      autoPromoteTrusted: source.promotion?.autoPromoteTrusted ?? false,
      createAssets: source.promotion?.createAssets ?? true,
      assetRelationship: source.promotion?.assetRelationship || 'attachment',
    },
  };
}

let editing = $state<Partial<ContentContributionTypeData> | null>(null);
let draft = $state(createDraft());

$effect(() => {
  draft = createDraft(editing || {});
});

function toggleChannel(channel: string) {
  draft.allowedChannels = draft.allowedChannels.includes(channel)
    ? draft.allowedChannels.filter((item: string) => item !== channel)
    : [...draft.allowedChannels, channel];
}

function csv(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function handleSubmit() {
  onSave({
    ...editing,
    key: draft.key,
    label: draft.label,
    enabled: draft.enabled,
    allowedChannels: draft.allowedChannels,
    allowText: draft.allowText,
    allowFiles: draft.allowFiles,
    allowEmptyText: draft.allowEmptyText,
    intakeRules: {
      maxFiles: draft.intakeRules.maxFiles
        ? Number(draft.intakeRules.maxFiles)
        : null,
      maxTotalBytes: draft.intakeRules.maxTotalBytes
        ? Number(draft.intakeRules.maxTotalBytes)
        : null,
      allowedMimePatterns: csv(draft.intakeRules.allowedMimePatterns),
      blockedMimePatterns: csv(draft.intakeRules.blockedMimePatterns),
      quarantineMimePatterns: csv(draft.intakeRules.quarantineMimePatterns),
      blockedTextPatterns: csv(draft.intakeRules.blockedTextPatterns),
      quarantineTextPatterns: csv(draft.intakeRules.quarantineTextPatterns),
      trustedOnly: draft.intakeRules.trustedOnly,
    },
    promotion: {
      targetContentType: draft.promotion.targetContentType,
      targetContentVariant: draft.promotion.targetContentVariant || null,
      targetContentStatus: draft.promotion.targetContentStatus,
      autoPromoteTrusted: draft.promotion.autoPromoteTrusted,
      createAssets: draft.promotion.createAssets,
      assetRelationship: draft.promotion.assetRelationship,
    },
  });
}
</script>

<section class="manager">
  <header>
    <div>
      <h3>Contribution types</h3>
      <p>Configure what contributors can send, where it promotes, and which intake rules apply.</p>
    </div>
    <button type="button" onclick={() => (editing = {})}>Add type</button>
  </header>

  <div class="layout">
    <div class="list">
      {#each types as type (type.id ?? type.key)}
        <article class="card">
          <div>
            <strong>{type.label}</strong>
            <div>{type.key}</div>
          </div>
          <div class="actions">
            <button type="button" class="secondary" onclick={() => (editing = type)}>Edit</button>
            {#if onDelete && type.id}
              <button type="button" class="danger" onclick={() => onDelete?.(type)}>Delete</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>

    <form
      class="editor"
      onsubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <label>
        Key
        <input type="text" bind:value={draft.key} required />
      </label>
      <label>
        Label
        <input type="text" bind:value={draft.label} required />
      </label>

      <div class="checkbox-grid">
        <label><input type="checkbox" bind:checked={draft.enabled} /> Enabled</label>
        <label><input type="checkbox" bind:checked={draft.allowText} /> Allow text</label>
        <label><input type="checkbox" bind:checked={draft.allowFiles} /> Allow files</label>
        <label><input type="checkbox" bind:checked={draft.allowEmptyText} /> Allow empty text</label>
      </div>

      <div class="checkbox-grid">
        <label>
          <input
            type="checkbox"
            checked={draft.allowedChannels.includes('web')}
            onchange={() => toggleChannel('web')}
          />
          Web
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.allowedChannels.includes('email')}
            onchange={() => toggleChannel('email')}
          />
          Email
        </label>
      </div>

      <label>
        Promotion content type
        <input type="text" bind:value={draft.promotion.targetContentType} required />
      </label>
      <label>
        Promotion variant
        <input type="text" bind:value={draft.promotion.targetContentVariant} />
      </label>
      <label>
        Promotion status
        <select bind:value={draft.promotion.targetContentStatus}>
          <option value="draft">draft</option>
          <option value="review">review</option>
        </select>
      </label>

      <div class="checkbox-grid">
        <label><input type="checkbox" bind:checked={draft.promotion.autoPromoteTrusted} /> Auto-promote trusted</label>
        <label><input type="checkbox" bind:checked={draft.promotion.createAssets} /> Create assets on promotion</label>
        <label><input type="checkbox" bind:checked={draft.intakeRules.trustedOnly} /> Trusted contributors only</label>
      </div>

      <label>
        Max files
        <input type="number" min="0" bind:value={draft.intakeRules.maxFiles} />
      </label>
      <label>
        Max total bytes
        <input type="number" min="0" bind:value={draft.intakeRules.maxTotalBytes} />
      </label>
      <label>
        Allowed MIME patterns
        <input type="text" bind:value={draft.intakeRules.allowedMimePatterns} placeholder="image/*, video/mp4" />
      </label>
      <label>
        Blocked MIME patterns
        <input type="text" bind:value={draft.intakeRules.blockedMimePatterns} />
      </label>
      <label>
        Quarantine MIME patterns
        <input type="text" bind:value={draft.intakeRules.quarantineMimePatterns} />
      </label>
      <label>
        Blocked text patterns
        <textarea bind:value={draft.intakeRules.blockedTextPatterns} rows="2"></textarea>
      </label>
      <label>
        Quarantine text patterns
        <textarea bind:value={draft.intakeRules.quarantineTextPatterns} rows="2"></textarea>
      </label>

      <div class="actions">
        <button type="submit">Save type</button>
      </div>
    </form>
  </div>
</section>

<style>
  .manager,
  .layout,
  .list,
  .editor {
    display: grid;
    gap: 1rem;
  }

  .layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }

  .card,
  .editor {
    border: 1px solid #d9d9d9;
    border-radius: 0.75rem;
    padding: 0.9rem;
    background: #fff;
  }

  .card,
  .actions,
  .checkbox-grid,
  header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .editor label {
    display: grid;
    gap: 0.35rem;
  }

  @media (max-width: 720px) {
    .layout {
      grid-template-columns: 1fr;
    }
  }
</style>
