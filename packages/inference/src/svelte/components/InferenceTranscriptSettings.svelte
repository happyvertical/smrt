<script lang="ts">
/**
 * The app's transcript setting in Advanced (#4781). Read-only unless the
 * host passes `editable` (platform admin, `appEditable` on the panel):
 * tenants cannot override transcripts, and a save always writes the app
 * row. Retention is the sweep's policy and stays read-only. Renders no
 * transcript content.
 */
import type {
  InferenceTranscriptSettingsChange,
  InferenceTranscriptSettingsView,
} from '../types.js';

interface InferenceTranscriptSettingsProps {
  settings: InferenceTranscriptSettingsView;
  editable: boolean;
  busy: boolean;
  onSaveTranscripts?: (change: InferenceTranscriptSettingsChange) => void;
}

const {
  settings,
  editable,
  busy,
  onSaveTranscripts,
}: InferenceTranscriptSettingsProps = $props();

const LEVELS: Record<string, string> = {
  env: 'SMRT_INFERENCE_TRANSCRIPTS',
  app: 'App setting',
  config: 'Config',
  default: 'Default',
};

const retention = $derived(
  settings.retentionDays === null || settings.retentionDays === undefined
    ? 'not pruned'
    : `${settings.retentionDays} days`,
);

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function save(event: SubmitEvent): void {
  event.preventDefault();
  if (!onSaveTranscripts) return;
  const data = new FormData(event.currentTarget as HTMLFormElement);
  onSaveTranscripts({
    settings: {
      enabled: data.get('enabled') === 'on',
      sample: Number(data.get('sample')),
      maxBytes: Number(data.get('maxBytes')),
    },
  });
}

function revert(): void {
  onSaveTranscripts?.({ settings: null });
}
</script>

<div class="smrt-inference-transcript-settings__root" data-testid="inference-transcripts" data-smrt-component="InferenceTranscriptSettings">
  {#if settings.envEnabled !== null && settings.envEnabled !== undefined}
    <p class="smrt-inference-transcript-settings__hint" data-smrt-part="description" data-testid="inference-transcripts-env">
      SMRT_INFERENCE_TRANSCRIPTS turns transcripts {settings.envEnabled ? 'on' : 'off'} over this setting.
    </p>
  {/if}
  {#if editable}
    <form class="smrt-inference-transcript-settings__form" data-smrt-part="field" onsubmit={save} data-testid="inference-transcripts-form">
      <label>
        <input type="checkbox" name="enabled" checked={settings.enabled} disabled={busy} />
        Store transcripts
      </label>
      <label>
        <span class="smrt-inference-transcript-settings__hint" data-smrt-part="description">Success sample rate (0–1)</span>
        <input
          type="number"
          name="sample"
          min="0"
          max="1"
          step="0.01"
          value={settings.sample}
          disabled={busy}
          required
        />
      </label>
      <label>
        <span class="smrt-inference-transcript-settings__hint" data-smrt-part="description">Max bytes per call</span>
        <input
          type="number"
          name="maxBytes"
          min="1024"
          step="1"
          value={settings.maxBytes}
          disabled={busy}
          required
        />
      </label>
      <button type="submit" disabled={busy}>Save</button>
      {#if settings.appValue}
        <button type="button" disabled={busy} onclick={revert}>
          Revert to config{settings.appRevert
            ? ` (${settings.appRevert.enabled ? 'on' : 'off'})`
            : ''}
        </button>
      {/if}
    </form>
  {/if}
  <dl class="smrt-inference-transcript-settings__values" data-smrt-part="list">
    {#if !editable}
      <dt>Stored</dt>
      <dd data-testid="inference-transcripts-enabled">{settings.enabled ? 'On' : 'Off'}</dd>
      <dt>Success sample rate</dt>
      <dd>{percent(settings.sample)}</dd>
      <dt>Max bytes per call</dt>
      <dd>{settings.maxBytes}</dd>
    {/if}
    <dt>Retention</dt>
    <dd data-testid="inference-transcripts-retention">{retention}</dd>
    {#if settings.supplyingLevel}
      <dt>Set by</dt>
      <dd>{LEVELS[settings.supplyingLevel] ?? settings.supplyingLevel}</dd>
    {/if}
  </dl>
  {#if settings.promptOverrides && settings.promptOverrides.length > 0}
    <p class="smrt-inference-transcript-settings__hint" data-smrt-part="description">
      Config sets its own sample rate for {settings.promptOverrides.length} prompt key(s).
    </p>
  {/if}
  {#if !editable}
    <p class="smrt-inference-transcript-settings__hint" data-smrt-part="description">App-wide setting; tenants cannot change it.</p>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-inference-transcript-settings__root {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-inference-transcript-settings__form {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .smrt-inference-transcript-settings__values {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
  }
  .smrt-inference-transcript-settings__values dd {
    margin: 0;
  }
  .smrt-inference-transcript-settings__hint {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-inference-transcript-settings__hint {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
