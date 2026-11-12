<script lang="ts">
import {
  AiUnavailableNotice,
  AssistantDock,
  type AssistantDockController,
  type AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n/strings.onboarding.js';

let {
  transport,
  registry,
  visible = true,
  contextMode,
  messageFormat,
  toolPresentation,
  introduction,
}: {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  visible?: boolean;
  contextMode?: 'server' | 'data-surfaces';
  messageFormat?: 'text' | 'markdown';
  toolPresentation?: 'generic';
  introduction?: { lists: string[]; actions: string[]; configured: boolean };
} = $props();
const { t } = useI18n();
let controller = $state<AssistantDockController>();
const help = $derived(
  introduction?.actions.includes('read')
    ? introduction.actions.includes('create')
      ? M['ui.onboarding.find_add']
      : M['ui.onboarding.find']
    : introduction?.actions.includes('create')
      ? M['ui.onboarding.add']
      : introduction?.actions.includes('update')
        ? M['ui.onboarding.change']
        : introduction?.actions.includes('customize')
          ? M['ui.onboarding.build']
          : undefined,
);
</script>
<div class="onboarding-assistant" data-smrt-component="OnboardingAssistant">
{#if introduction?.configured === false}
  <AiUnavailableNotice status={{ reason: 'unconfigured' }} settingsHref="/settings" settingsLabel={t(M['ui.onboarding.connect_prompt'])} />
{:else}
{#if introduction && !controller?.messages.length}
  <div class="introduction" aria-label={t(M['ui.onboarding.ai'])}>
    {#if introduction.lists.length}<p>{t(M['ui.onboarding.lists'], { lists: introduction.lists.slice(0, 3).join(', ') })}</p>{/if}
    {#if help}<p>{t(help)}</p>{/if}
  </div>
{/if}
<div class="dock"><AssistantDock {transport} {registry} {visible} {contextMode} {messageFormat} {toolPresentation} aiSettingsHref="/settings" oncontroller={next => { controller = next; }} /></div>
{/if}
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure { .onboarding-assistant { display: flex; flex-direction: column; height: 100%; min-height: 0; } .dock { flex: 1; min-height: 0; } .introduction { padding: var(--smrt-spacing-3); color: var(--smrt-color-on-surface); } }
</style>
