<script lang="ts">
import { Input, Select, Switch } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  HelperClient,
  HelperOffering,
  HelperPreferences,
  HelperSnapshot,
} from '../../../helper-preferences.js';
import { M } from '../../i18n.messages.js';
import type { HelperRendererHandle, HelperStyleRegistry } from './registry.js';

export interface Props {
  /** Authenticated browser transport; only server snapshots become applied state. */
  client: HelperClient;
  /** Trusted style implementations available to this host. */
  registry: HelperStyleRegistry;
  /** Optional host-owned current snapshot. Absent snapshots load on mount. */
  snapshot?: HelperSnapshot;
  /**
   * Authenticated bridge for a selected offering's runtime payload. The
   * payload is deliberately never persisted by this panel or preferences.
   */
  loadPayload?: (offering: HelperOffering) => Promise<unknown>;
  /** Receives each successful server-returned snapshot. */
  onchanged?: (snapshot: HelperSnapshot) => void;
  /** Notifies the host after an authenticated custom setup creates an offering. */
  oncustomsaved?: (offering: HelperOffering) => void;
}
const { t } = useI18n();
let {
  client,
  registry,
  snapshot = $bindable(),
  loadPayload,
  onchanged,
  oncustomsaved,
}: Props = $props();
let loading = $state(!snapshot);
let saving = $state(false);
let message = $state<string | null>(null);
let draft = $state<HelperPreferences | null>(
  snapshot?.preferences ? { ...snapshot.preferences } : null,
);
let setupStyleId = $state<string | null>(null);
let previewTarget = $state<HTMLElement>();
let previewError = $state<string | null>(null);

$effect(() => {
  if (snapshot?.preferences) draft = { ...snapshot.preferences };
});
$effect(() => {
  if (snapshot) {
    loading = false;
    return;
  }
  let active = true;
  void client
    .load()
    .then((next) => {
      if (!active) return;
      snapshot = next;
      draft = next.preferences ? { ...next.preferences } : null;
    })
    .catch((error: unknown) => {
      if (active)
        message =
          error instanceof Error
            ? error.message
            : t(M['chat.helper.load_failed']);
    })
    .finally(() => {
      if (active) loading = false;
    });
  return () => {
    active = false;
  };
});

const editable = (field: keyof Omit<HelperPreferences, 'version'>) =>
  !!snapshot?.permissions.editableFields.includes(field);
const canSave = $derived(
  !!draft && (snapshot?.permissions.editableFields.length ?? 0) > 0,
);
const availableOfferings = $derived(
  (snapshot?.offerings ?? []).filter((offering) =>
    registry.get(offering.styleId),
  ),
);
const availableSetups = $derived(
  registry
    .list()
    .filter(
      (style) =>
        style.Setup && snapshot?.permissions.customStyleIds.includes(style.id),
    ),
);
const previewOffering = $derived(
  draft
    ? (availableOfferings.find(
        (offering) => offering.id === draft?.offeringId,
      ) ?? null)
    : (snapshot?.offering ?? null),
);

$effect(() => {
  const offering = previewOffering;
  const style = offering ? registry.get(offering.styleId) : undefined;
  const target = previewTarget;
  let disposed = false;
  let handle: HelperRendererHandle | null = null;
  previewError = null;
  if (!offering || !style || !target) return;
  void (async () => {
    try {
      const payload = loadPayload ? await loadPayload(offering) : null;
      const mounted = await style.mount({ target, offering, payload });
      if (disposed) mounted.destroy();
      else handle = mounted;
    } catch (error) {
      if (!disposed)
        previewError =
          error instanceof Error
            ? error.message
            : t(M['chat.helper.preview_failed']);
    }
  })();
  return () => {
    disposed = true;
    handle?.destroy();
    handle = null;
  };
});

function update<K extends keyof HelperPreferences>(
  key: K,
  value: HelperPreferences[K],
) {
  if (draft) draft = { ...draft, [key]: value };
}
async function save() {
  if (!draft || saving) return;
  saving = true;
  message = null;
  try {
    apply(await client.save(draft));
    message = t(M['chat.helper.saved']);
  } catch (error) {
    message =
      error instanceof Error ? error.message : t(M['chat.helper.save_failed']);
  } finally {
    saving = false;
  }
}
async function reset() {
  if (saving || !snapshot?.permissions.canReset) return;
  saving = true;
  message = null;
  try {
    apply(await client.reset());
    message = t(M['chat.helper.reset']);
  } catch (error) {
    message =
      error instanceof Error ? error.message : t(M['chat.helper.reset_failed']);
  } finally {
    saving = false;
  }
}
function apply(next: HelperSnapshot) {
  snapshot = next;
  draft = next.preferences ? { ...next.preferences } : null;
  onchanged?.(next);
}
async function customSaved(offering: HelperOffering) {
  oncustomsaved?.(offering);
  try {
    apply(await client.load());
    setupStyleId = null;
  } catch (error) {
    message =
      error instanceof Error ? error.message : t(M['chat.helper.load_failed']);
  }
}
</script>

<section class="helper-panel" aria-busy={loading || saving} aria-labelledby="helper-panel-title">
  <h2 id="helper-panel-title">{t(M['chat.helper.title'])}</h2>
  {#if message}<p class="message" aria-live="polite">{message}</p>{/if}
  {#if snapshot?.recovery}<p class="message" role="status">{snapshot.recovery.message}</p>{/if}
  {#if loading}<p>{t(M['chat.helper.loading'])}</p>
  {:else if !snapshot}<p>{t(M['chat.helper.unavailable'])}</p>
  {:else}
    <fieldset disabled={saving}>
      <legend>{t(M['chat.helper.gallery'])}</legend>
      <div class="gallery" role="radiogroup" aria-label={t(M['chat.helper.gallery'])}>
        {#each availableOfferings as offering (offering.id)}
          <Button type="button" variant="secondary" class={draft?.offeringId === offering.id ? 'selected' : ''} role="radio" aria-checked={draft?.offeringId === offering.id}
            disabled={!draft || !editable('offeringId')} onclick={() => update('offeringId', offering.id)}>{offering.label}</Button>
        {/each}
      </div>
      {#if previewOffering}
        <div class="preview" aria-label={t(M['chat.helper.preview'])} bind:this={previewTarget}></div>
      {/if}
      {#if previewError}<p class="message" role="status">{previewError}</p>{/if}
      {#if availableSetups.length}
        <div class="setup-actions">
          {#each availableSetups as style (style.id)}
            <Button type="button" variant="secondary" disabled={!editable('offeringId')} onclick={() => setupStyleId = style.id}>{t(M['chat.helper.add_style'], { style: style.label })}</Button>
          {/each}
        </div>
      {/if}
      {#if setupStyleId && registry.get(setupStyleId)?.Setup}
        {@const Setup = registry.get(setupStyleId)?.Setup}
        {#if Setup}<Setup onsaved={customSaved} oncancel={() => setupStyleId = null} />{/if}
      {/if}
      {#if draft}
        <label>{t(M['chat.helper.name'])}<Input value={draft.name} disabled={!editable('name')} oninput={(event) => update('name', event.currentTarget.value)} /></label>
        <label>{t(M['chat.helper.voice'])}<Select value={draft.voiceId} disabled={!editable('voiceId')} onchange={(event) => update('voiceId', event.currentTarget.value)}>{#each snapshot.voices as voice (voice.id)}<option value={voice.id}>{voice.label}</option>{/each}</Select></label>
        <label>{t(M['chat.helper.placement'])}<Select value={draft.placement} disabled={!editable('placement')} onchange={(event) => update('placement', event.currentTarget.value as HelperPreferences['placement'])}><option value="bottom-left">{t(M['chat.helper.bottom_left'])}</option><option value="bottom-right">{t(M['chat.helper.bottom_right'])}</option></Select></label>
        <Switch label={t(M['chat.helper.heard_subtitles'])} checked={draft.heardSubtitles} disabled={!editable('heardSubtitles')} onchange={(event) => update('heardSubtitles', event.currentTarget.checked)} />
        <Switch label={t(M['chat.helper.spoken_subtitles'])} checked={draft.spokenSubtitles} disabled={!editable('spokenSubtitles')} onchange={(event) => update('spokenSubtitles', event.currentTarget.checked)} />
      {:else}
        <p class="message">{t(M['chat.helper.unavailable'])}</p>
      {/if}
    </fieldset>
    <div class="actions">{#if canSave}<Button type="button" onclick={save} disabled={saving}>{saving ? t(M['chat.helper.saving']) : t(M['chat.helper.save'])}</Button>{/if}{#if snapshot.permissions.canReset}<Button type="button" variant="secondary" onclick={reset} disabled={saving}>{t(M['chat.helper.reset_button'])}</Button>{/if}</div>
  {/if}
</section>

<style>
  .helper-panel { display: grid; gap: var(--smrt-spacing-4); max-width: 42rem; padding: var(--smrt-spacing-4); color: var(--smrt-color-on-surface); }
  fieldset { display: grid; gap: var(--smrt-spacing-3); border: 0; margin: 0; padding: 0; }
  label { display: grid; gap: var(--smrt-spacing-1); font: var(--smrt-typography-label-large-font); }
  .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--smrt-spacing-2); }
  .gallery :global(.button) { min-height: 3rem; border-color: var(--smrt-color-outline); background: var(--smrt-color-surface); color: inherit; }
  .gallery :global(.button.selected) { border-color: var(--smrt-color-primary); background: var(--smrt-color-primary-container); }
  .preview { min-height: 5rem; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-small); background: var(--smrt-color-surface-container-low); }
  .preview :global(svg), .preview :global(img) { max-width: 100%; max-height: 12rem; }
  .setup-actions, .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); }
  .message { margin: 0; color: var(--smrt-color-on-surface-variant); }
</style>
