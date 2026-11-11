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
  introduction,
}: {
  transport: AssistantTransport;
  registry: DataSurfaceRegistry;
  visible?: boolean;
  contextMode?: 'server' | 'data-surfaces';
  messageFormat?: 'text' | 'markdown';
  introduction?: { lists: string[]; actions: string[]; configured: boolean };
} = $props();
const { t } = useI18n();
let controller = $state<AssistantDockController>();
const labels = {
  read: M['ui.onboarding.read'],
  create: M['ui.onboarding.create'],
  update: M['ui.onboarding.update'],
  delete: M['ui.onboarding.delete'],
  customize: M['ui.onboarding.customize'],
};
</script>
<div class="onboarding-assistant" data-smrt-component="OnboardingAssistant">
{#if introduction?.configured === false}
  <AiUnavailableNotice status={{ reason: 'unconfigured' }} settingsHref="/settings" settingsLabel={t(M['ui.onboarding.connect_prompt'])} />
{:else}
{#if introduction && !controller?.messages.length}
  <div class="introduction" aria-label={t(M['ui.onboarding.ai'])}>
    {#if introduction.lists.length}<p>{t(M['ui.onboarding.lists'], { lists: introduction.lists.join(', ') })}</p>{/if}
    {#if introduction.actions.length}<p>{t(M['ui.onboarding.tools'], { actions: introduction.actions.filter(a => a in labels).map(a => t(labels[a as keyof typeof labels])).join(', ') })}</p>{/if}
  </div>
{/if}
<div class="dock"><AssistantDock {transport} {registry} {visible} {contextMode} {messageFormat} aiSettingsHref="/settings" oncontroller={next => { controller = next; }} /></div>
{/if}
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure { .onboarding-assistant { display: flex; flex-direction: column; height: 100%; min-height: 0; } .dock { flex: 1; min-height: 0; } .introduction { padding: var(--smrt-spacing-3); color: var(--smrt-color-on-surface); } }
</style>
