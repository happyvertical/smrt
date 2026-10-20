<script lang="ts">
import {
  shellTargetAction,
  tryUseShellTargets,
} from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui';
import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import type { PlannerController } from './commands/index.ts';
import { capturePlannerExport } from './export-context.ts';
import { plannerController } from './instance.ts';
import type { PlannerExportAction } from './types.ts';

interface Props {
  action: PlannerExportAction;
  controller?: PlannerController;
  nativeAssistant?: BrowserAssistantTransport;
}
let {
  action,
  controller = plannerController,
  nativeAssistant,
}: Props = $props();
const target = shellTargetAction(tryUseShellTargets());
let pending = $state(false);
let busy = $state(false);
let error = $state('');
$effect(() => {
  busy = nativeAssistant?.busy ?? false;
  return nativeAssistant?.subscribeConversation(() => {
    busy = nativeAssistant?.busy ?? false;
  });
});
async function run() {
  if (pending || busy) return;
  error = '';
  pending = true;
  try {
    await action.run(capturePlannerExport(controller, nativeAssistant));
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'The action could not finish. Try again.';
  } finally {
    pending = false;
  }
}
</script>

<div use:target={'item:planner-host-action'} class="host-action" data-planner-host-action>
  <Button disabled={pending || busy} onclick={run}>{action.label}</Button>
  {#if error}<span class="action-error" role="alert">{error}</span>{/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.host-action { position: relative; flex-shrink: 0; }
.action-error { position: absolute; inset-block-start: 100%; inset-inline-end: 0; inline-size: min(20rem, 80vw); padding: var(--smrt-spacing-2); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); border: var(--smrt-hairline); border-radius: var(--smrt-radius-small); z-index: var(--smrt-z-index-popover); }
}
</style>
