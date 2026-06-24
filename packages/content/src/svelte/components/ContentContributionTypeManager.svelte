<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentContributionTypeData } from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

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
      <h3>{t(M['content.contribution_type_manager.heading'])}</h3>
      <p>{t(M['content.contribution_type_manager.intro'])}</p>
    </div>
    <Button variant="ghost" type="button" onclick={() => (editing = {})}>{t(M['content.contribution_type_manager.add_type'])}</Button>
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
            <Button variant="secondary" type="button" onclick={() => (editing = type)}>Edit</Button>
            {#if onDelete && type.id}
              <Button variant="danger" type="button" onclick={() => onDelete?.(type)}>Delete</Button>
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
        <label><input type="checkbox" bind:checked={draft.allowText} /> {t(M['content.contribution_type_manager.allow_text'])}</label>
        <label><input type="checkbox" bind:checked={draft.allowFiles} /> {t(M['content.contribution_type_manager.allow_files'])}</label>
        <label><input type="checkbox" bind:checked={draft.allowEmptyText} /> {t(M['content.contribution_type_manager.allow_empty_text'])}</label>
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
        {t(M['content.contribution_type_manager.promotion_content_type'])}
        <input type="text" bind:value={draft.promotion.targetContentType} required />
      </label>
      <label>
        {t(M['content.contribution_type_manager.promotion_variant'])}
        <input type="text" bind:value={draft.promotion.targetContentVariant} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.promotion_status'])}
        <select bind:value={draft.promotion.targetContentStatus}>
          <option value="draft">draft</option>
          <option value="review">review</option>
        </select>
      </label>

      <div class="checkbox-grid">
        <label><input type="checkbox" bind:checked={draft.promotion.autoPromoteTrusted} /> {t(M['content.contribution_type_manager.auto_promote_trusted'])}</label>
        <label><input type="checkbox" bind:checked={draft.promotion.createAssets} /> {t(M['content.contribution_type_manager.create_assets_on_promotion'])}</label>
        <label><input type="checkbox" bind:checked={draft.intakeRules.trustedOnly} /> {t(M['content.contribution_type_manager.trusted_contributors_only'])}</label>
      </div>

      <label>
        {t(M['content.contribution_type_manager.max_files'])}
        <input type="number" min="0" bind:value={draft.intakeRules.maxFiles} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.max_total_bytes'])}
        <input type="number" min="0" bind:value={draft.intakeRules.maxTotalBytes} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.allowed_mime_patterns'])}
        <input type="text" bind:value={draft.intakeRules.allowedMimePatterns} placeholder={t(M['content.contribution_type_manager.allowed_mime_patterns_placeholder'])} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.blocked_mime_patterns'])}
        <input type="text" bind:value={draft.intakeRules.blockedMimePatterns} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.quarantine_mime_patterns'])}
        <input type="text" bind:value={draft.intakeRules.quarantineMimePatterns} />
      </label>
      <label>
        {t(M['content.contribution_type_manager.blocked_text_patterns'])}
        <textarea bind:value={draft.intakeRules.blockedTextPatterns} rows="2"></textarea>
      </label>
      <label>
        {t(M['content.contribution_type_manager.quarantine_text_patterns'])}
        <textarea bind:value={draft.intakeRules.quarantineTextPatterns} rows="2"></textarea>
      </label>

      <div class="actions">
        <Button variant="primary" type="submit">{t(M['content.contribution_type_manager.save_type'])}</Button>
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
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.9rem;
    background: var(--smrt-color-surface);
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
