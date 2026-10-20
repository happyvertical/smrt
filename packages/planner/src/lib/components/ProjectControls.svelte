<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { Alert, ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Switch } from '@happyvertical/smrt-ui/forms';
import { tick } from 'svelte';
import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import { useDataSource } from '../data/context.ts';
import type { PlannerController } from '../planner/commands/index.ts';
import { plannerController } from '../planner/instance.ts';
import {
  resetWorkspace,
  workspacePersistence,
} from '../planner/workspace.svelte.ts';

interface Props {
  controller?: PlannerController;
  nativeAssistant?: BrowserAssistantTransport;
  onreset?: () => void;
  resetDisabledReason?: string;
  resetOnly?: boolean;
}
let {
  controller = plannerController,
  nativeAssistant,
  onreset,
  resetDisabledReason,
  resetOnly = false,
}: Props = $props();
const dataSource = useDataSource();
let confirming = $state(false);
let recovering = $state(false);
let error = $state('');
let notice = $state('');
let remembering = $state(workspacePersistence.remembering);
$effect(() => {
  remembering = workspacePersistence.remembering;
});

function remember(value: boolean) {
  error = workspacePersistence.setRemember(value)
    ? ''
    : 'Your storage preference could not be changed. Your existing plan is preserved.';
}
function reset() {
  confirming = false;
  if (resetDisabledReason) return;
  error = '';
  if (!resetWorkspace({ controller, dataSource, nativeAssistant, onreset })) {
    error = 'The project could not be fully reset. Please try again.';
    return;
  }
  notice = 'Project reset. Start a new plan whenever you are ready.';
}
function recover() {
  recovering = false;
  if (resetDisabledReason) return;
  if (!workspacePersistence.recover()) {
    error =
      'The previous plan could not be recovered. Its saved copy is preserved.';
    return;
  }
  location.reload();
}
function discard() {
  error = workspacePersistence.discardRecovery()
    ? ''
    : 'The previous saved copy could not be removed. Please try again.';
}
</script>

<section class="project" aria-label="Project">
  {#if !resetOnly}
    <h2>Project</h2>
    <p class="meta">Your plan, sample records and settings stay in this browser session by default. Conversations and contact or request drafts stay in the current tab session.</p>
    <Switch
      label="Remember this plan"
      bind:checked={remembering}
      onchange={async (event) => {
        const input = event.currentTarget;
        remember(input.checked);
        await tick();
        remembering = workspacePersistence.remembering;
        input.checked = remembering;
      }}
    />
    <p class="meta">Remembering keeps your cookbook, sample records and settings on this device after the session ends. Conversations and contact or request drafts still stay in the current tab session. Turn it off to remove the remembered project copy.</p>
    {#if workspacePersistence.recoveryAvailable}
      <Alert variant="info" title="Previous saved plan available">
        An earlier project has been kept as a recovery copy of its cookbook, sample records and settings. Recover it to replace this project, or discard the copy. Conversations are not remembered.
      </Alert>
      <div class="actions">
        <Button variant="secondary" onclick={() => (recovering = true)} disabled={!!resetDisabledReason}>Recover previous plan</Button>
        <Button variant="ghost" onclick={discard}>Discard saved copy</Button>
      </div>
    {/if}
  {/if}
  <div class="actions">
    <Button variant="ghost" disabled={!!resetDisabledReason} onclick={() => (confirming = true)}>Reset project</Button>
  </div>
  {#if resetDisabledReason}<p class="meta" role="status">{resetDisabledReason}</p>{/if}
  {#if error}<Alert variant="error" title="Project action could not finish">{error}</Alert>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</section>

<ConfirmDialog
  open={recovering}
  title="Recover the previous plan?"
  message="Recovering replaces this project with its previous cookbook, sample records and settings. Current manual edits will be lost. It does not recover conversations or contact and request drafts."
  confirmLabel="Recover plan"
  destructive
  onconfirm={recover}
  oncancel={() => (recovering = false)}
/>

<ConfirmDialog
  open={confirming}
  title="Reset this project?"
  message="This clears your plan, conversation, sample records, manual edits and current Build it draft. Manual edits will be lost. Your theme preference and identity settings are kept. Download the cookbook first if you want a copy. A reset cannot unsend a request you already sent."
  confirmLabel="Reset project"
  destructive
  onconfirm={reset}
  oncancel={() => (confirming = false)}
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .project { display: grid; gap: var(--smrt-spacing-3); }
  h2, p { margin: 0; }
  .meta { color: var(--smrt-color-on-surface-variant); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); }
}
</style>
