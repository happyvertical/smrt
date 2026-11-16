<script lang="ts">
/**
 * The assistant's ordinary settings (#5005): hand chat requests for
 * workflow-only changes to a workflow run, preview before applying, ask before
 * removals, and protect this computer from local AI tools. Every one is on
 * unless the owner turns it off. Turning protection off needs a second,
 * explicit confirmation. Presentational: the host saves through its own
 * owner-checked action.
 */
import type {
  InferenceAssistantSettingsChange,
  InferenceAssistantSettingsView,
} from '../types.js';

interface InferenceAssistantSettingsProps {
  view: InferenceAssistantSettingsView;
  busy: boolean;
  onSaveAssistant?: (change: InferenceAssistantSettingsChange) => void;
  onResetAssistant?: () => void;
}

const {
  view,
  busy,
  onSaveAssistant,
  onResetAssistant,
}: InferenceAssistantSettingsProps = $props();

const editable = $derived(view.editable && !!onSaveAssistant);
const protectedNow = $derived(view.settings.protectLocalCli !== false);
let protectOff = $state(false);

function save(event: SubmitEvent): void {
  event.preventDefault();
  if (!onSaveAssistant) return;
  const data = new FormData(event.currentTarget as HTMLFormElement);
  const protect = data.get('protectLocalCli') === 'on';
  onSaveAssistant({
    settings: {
      escalateToWorkflow: data.get('escalateToWorkflow') === 'on',
      previewBeforeApply: data.get('previewBeforeApply') === 'on',
      requireRemovalApproval: data.get('requireRemovalApproval') === 'on',
      protectLocalCli: protect,
    },
    ...(!protect && protectedNow
      ? { confirmUnprotectedCli: data.get('confirmUnprotectedCli') === 'on' }
      : {}),
  });
}
</script>

<div class="smrt-inference-assistant-settings__root" data-testid="inference-assistant" data-smrt-component="InferenceAssistantSettings">
  <form class="smrt-inference-assistant-settings__form" data-smrt-part="field" onsubmit={save} data-testid="inference-assistant-form">
    <label>
      <input type="checkbox" name="escalateToWorkflow" checked={view.settings.escalateToWorkflow !== false} disabled={!editable || busy} />
      Hand changes to the app's structure to a workflow run
    </label>
    <label>
      <input type="checkbox" name="previewBeforeApply" checked={view.settings.previewBeforeApply !== false} disabled={!editable || busy} />
      Preview a workflow run's changes before applying them
    </label>
    <label>
      <input type="checkbox" name="requireRemovalApproval" checked={view.settings.requireRemovalApproval !== false} disabled={!editable || busy} />
      Ask before deleting or removing
    </label>
    <p class="smrt-inference-assistant-settings__hint" data-smrt-part="description">
      Applies to chat in this app. Deleted records cannot be restored. Requests from outside this app and permanent purges always need owner approval.
    </p>
    <label>
      <input
        type="checkbox"
        name="protectLocalCli"
        checked={protectedNow}
        disabled={!editable || busy}
        onchange={(event) => (protectOff = !event.currentTarget.checked)}
      />
      Protect this computer from local AI tools
    </label>
    <p class="smrt-inference-assistant-settings__hint" data-smrt-part="description">
      When on, Claude Code and Codex use the app's protected tool setup. When off, they can use their own tools, settings and plugins in the app's data folder.
    </p>
    {#if protectOff && protectedNow}
      <p class="smrt-inference-assistant-settings__warning" data-smrt-part="message" role="alert">
        A chat message in this app can then run commands and change files on this computer, including this app's own data, without asking you first.
      </p>
      <label>
        <input type="checkbox" name="confirmUnprotectedCli" disabled={busy} data-testid="inference-assistant-confirm" />
        I understand: turn off local AI protection
      </label>
    {/if}
    {#if editable}
      <button type="submit" disabled={busy}>Save assistant settings</button>
      {#if onResetAssistant}
        <button type="button" disabled={busy} onclick={() => onResetAssistant?.()}>Reset to defaults</button>
      {/if}
    {/if}
  </form>
</div>
