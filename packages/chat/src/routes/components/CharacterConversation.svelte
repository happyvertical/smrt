<script lang="ts">
import {
  createDataSurfaceRegistry,
  type DataSurfaceActionRequest,
  type DataSurfaceActionResult,
} from '@happyvertical/smrt-ui/data-surface';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { createSpeechPlayback } from '@happyvertical/speech/browser';
import { onMount } from 'svelte';
import { createDevAssistantTransport } from '../../dev-assistant-transport.js';
import { createDevCharacterPersistenceClient } from '../../dev-character-persistence-client.js';
import type {
  HelperOffering,
  HelperSnapshot,
} from '../../helper-preferences.js';
import { createCaptionChannel } from '../../svelte/components/assistant/captions/caption-state.svelte.js';
import SpokenCaptions from '../../svelte/components/assistant/captions/SpokenCaptions.svelte';
import type {
  AssistantActionClient,
  AssistantDockController,
} from '../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';
import FloatingAssistant from '../../svelte/components/assistant/FloatingAssistant.svelte';
import type {
  HelperRendererHandle,
  HelperStyleRegistry,
} from '../../svelte/components/helper/registry.js';
import { M } from '../../svelte/i18n.js';
import { M as helperMessages } from '../../svelte/i18n.messages.js';
import { DEV_CHARACTER_MAX_DRAFT_LENGTH } from '../api/dev-character-conversation/protocol.js';
import CharacterConversationVoice from './CharacterConversationVoice.svelte';

const { t } = useI18n();

export interface Props {
  active?: boolean;
  workbenchAction?: {
    navigate?: (section: string) => void;
    stageDraft?: (value: string) => void;
    draftSubject?: () => string;
    section?: () => string;
  };
  helperSnapshot?: HelperSnapshot;
  helperRegistry?: HelperStyleRegistry;
  loadHelperPayload?: (offering: HelperOffering) => Promise<unknown>;
}
let {
  workbenchAction,
  active = true,
  helperSnapshot,
  helperRegistry,
  loadHelperPayload,
}: Props = $props();
const helperPreferences = $derived(helperSnapshot?.preferences);

let target: HTMLDivElement;
let mounted: HelperRendererHandle | null = null;
let unavailable = $state<string | null>(null);
let listening = $state(false);
let audioEnabled = $state(false);
let assistantExpanded = $state(false);
let controller = $state.raw<AssistantDockController | null>(null);
let conversationReady = $state(false);
let conversationError = $state<string | null>(null);
let latestReply = $state<string | null>(null);
let speechError = $state<string | null>(null);
let voiceTurnPending = $state(false);
const turnPending = $derived(
  voiceTurnPending ||
    !!controller?.pendingSends.some(
      (send) => send.status === 'sending' || send.status === 'processing',
    ),
);
let attentionRequired = $state(false);
let revision = $state(1);
let stateSignature = '';
const previews = new Map<string, { fingerprint: string; revision: number }>();
const applied = new Map<string, DataSurfaceActionResult>();
const registry = createDataSurfaceRegistry();
const identity = {
  surfaceId: 'character-conversation-controls',
  kind: 'table' as const,
};
registry.register({
  descriptor: {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Character conversation controls',
    rowKey: 'id',
    columns: [
      { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id'],
      searchableColumnIds: [],
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    actions: [
      {
        id: 'navigate',
        label: 'Navigate workbench',
        description: 'Open a known local workbench section.',
        selectionScopes: ['current-page'],
        requiresConfirmation: true,
      },
      {
        id: 'stage-draft',
        label: 'Stage draft subject',
        description: 'Stage a draft subject for review.',
        selectionScopes: ['current-page'],
        requiresConfirmation: true,
      },
    ],
    controls: [
      {
        id: 'data-surface.action.navigate',
        label: 'Apply navigation proposal',
      },
      { id: 'data-surface.action.stage-draft', label: 'Apply draft proposal' },
    ],
    limits: { maxQueryRows: 1, maxQueryBytes: 1024, maxSelectionSize: 1 },
  },
  getSnapshot: () => {
    const state = {
      rows: [
        {
          id: 'character-conversation',
          draftSubject: workbenchAction?.draftSubject?.() ?? '',
          section: workbenchAction?.section?.() ?? 'conversation',
        },
      ],
    };
    const nextSignature = JSON.stringify(state);
    if (stateSignature && stateSignature !== nextSignature) revision += 1;
    stateSignature = nextSignature;
    return { revision, state };
  },
  execute: async (command) => {
    const payload =
      command.payload &&
      typeof command.payload === 'object' &&
      !Array.isArray(command.payload)
        ? command.payload
        : {};
    if (command.controlId === 'data-surface.action.navigate') {
      const section = payload.section;
      if (
        typeof section !== 'string' ||
        !['character', 'conversation', 'chat'].includes(section)
      )
        return { ok: false };
      workbenchAction?.navigate?.(section);
    }
    if (command.controlId === 'data-surface.action.stage-draft') {
      const value = payload.value;
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > DEV_CHARACTER_MAX_DRAFT_LENGTH
      )
        return { ok: false };
      workbenchAction?.stageDraft?.(value);
    }
    return undefined;
  },
});
const actionClient: AssistantActionClient = {
  preview: async (request) => {
    const validation = registry.validateAction(request);
    if (!validation.ok || !isAllowedPayload(request))
      return {
        ...actionResult(request, 'preview'),
        ok: false,
        reason: validation.ok ? 'invalid_request' : validation.reason,
      };
    const fingerprint = JSON.stringify({ ...request, phase: 'preview' });
    // Bind confirmation to the registry's exposed snapshot, rather than a
    // component-local counter that can lag a reactive host update.
    const snapshot = registry.inspect(identity);
    previews.set(request.requestId, {
      fingerprint,
      revision: snapshot?.revision ?? revision,
    });
    const payload =
      request.payload &&
      typeof request.payload === 'object' &&
      !Array.isArray(request.payload)
        ? request.payload
        : {};
    return {
      ...actionResult(request, 'preview'),
      confirmationToken: request.requestId,
      details:
        request.actionId === 'stage-draft'
          ? {
              target: 'Draft subject',
              before: workbenchAction?.draftSubject?.() ?? '',
              after: String(payload.value ?? ''),
            }
          : {
              target: 'Workbench section',
              before: workbenchAction?.section?.() ?? 'conversation',
              after: String(payload.section ?? ''),
            },
    };
  },
  apply: async (request, key) => {
    const cached = applied.get(key);
    if (cached) return cached;
    const preview = previews.get(request.requestId);
    const { confirmationToken, ...proposal } = request;
    if (
      !preview ||
      confirmationToken !== request.requestId ||
      preview.fingerprint !== JSON.stringify({ ...proposal, phase: 'preview' })
    )
      return {
        ...actionResult(request, 'apply'),
        ok: false,
        reason: 'missing_preview',
      };
    const validation = registry.validateAction(request);
    if (!validation.ok || !isAllowedPayload(request))
      return {
        ...actionResult(request, 'apply'),
        ok: false,
        reason: validation.ok ? 'invalid_request' : validation.reason,
      };
    const outcome = await registry.execute({
      version: 1,
      commandId: request.requestId,
      identity,
      expectedRevision: preview.revision,
      controlId: `data-surface.action.${request.actionId}`,
      payload: request.payload,
    });
    const result = {
      ...actionResult(request, 'apply'),
      ok: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    };
    applied.set(key, result);
    return result;
  },
};
function actionResult(
  request: DataSurfaceActionRequest,
  phase: 'preview' | 'apply',
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: request.requestId,
    identity,
    actionId: request.actionId,
    phase,
    ok: true,
  };
}
function isAllowedPayload(request: DataSurfaceActionRequest) {
  const payload = request.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  if (request.actionId === 'navigate')
    return (
      Object.keys(payload).length === 1 &&
      typeof payload.section === 'string' &&
      ['character', 'conversation', 'chat'].includes(payload.section)
    );
  return (
    request.actionId === 'stage-draft' &&
    Object.keys(payload).length === 1 &&
    typeof payload.value === 'string' &&
    Boolean(payload.value.trim()) &&
    payload.value.length <= DEV_CHARACTER_MAX_DRAFT_LENGTH
  );
}
const spoken = createCaptionChannel('spoken', { ttlMs: 12000 });
let playingText = '';
let playback = createSpeechPlayback({
  onStart: () => {
    if (active) spoken.setInterim(playingText);
  },
  onEnd: () => {
    if (active && playingText) spoken.addFinal(playingText);
  },
  onLevel: (level) => {
    const gain = Math.min(1, Math.sqrt(Math.max(0, level)) * 1.25);
    mounted?.setMouthOpen(gain);
    mounted?.setSpeaking?.(gain > 0.05);
  },
});
let playbackGeneration = 0;
let speechAbort: AbortController | null = null;
const transport = createDevAssistantTransport(
  fetch,
  (reply) => {
    latestReply = reply;
    void speak(reply);
  },
  (proposal) => {
    if (!controller) return;
    void controller.previewAction({
      version: 1,
      requestId: crypto.randomUUID(),
      identity,
      actionId: proposal.kind === 'navigate' ? 'navigate' : 'stage-draft',
      phase: 'preview',
      selection: { scope: 'current-page' },
      payload:
        proposal.kind === 'navigate'
          ? { section: proposal.section }
          : { value: proposal.value },
    });
  },
);
function connect(owned: AssistantDockController) {
  controller = owned;
  conversationError = null;
  void owned
    .openThread('dev-character-conversation')
    .then(() => {
      if (owned.error) throw new Error(owned.error);
      conversationReady = true;
    })
    .catch(() => {
      conversationReady = false;
      conversationError = t(
        helperMessages['chat.helper.conversation_unavailable'],
      );
    });
}
function toggleListening() {
  if (listening) {
    listening = false;
    return;
  }
  // This only opens the existing assistant surface. It never requests a mic
  // permission or enables audio; those still require their own user actions.
  assistantExpanded = true;
  listening = true;
}
async function sendSpokenTurn(text: string) {
  if (!controller) throw new Error('Open the assistant before speaking.');
  if (turnPending || !active || attentionRequired) return;
  voiceTurnPending = true;
  try {
    await controller.send(text);
  } finally {
    voiceTurnPending = false;
  }
}

async function speak(reply: string) {
  const text = reply.slice(0, 500);
  const generation = ++playbackGeneration;
  speechAbort?.abort();
  const controller = new AbortController();
  speechAbort = controller;
  playingText = '';
  playback.stop();
  spoken.setInterim('');
  try {
    if (!audioEnabled || !active) return;
    speechError = null;
    const response = await fetch('/api/dev-character-speech', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      if (generation === playbackGeneration)
        speechError = t(M['chat.character_conversation.speech_failed']);
      return;
    }
    if (generation !== playbackGeneration) return;
    const audio = await response.arrayBuffer();
    if (
      generation !== playbackGeneration ||
      controller.signal.aborted ||
      !active
    )
      return;
    playingText = text;
    await playback.play({
      audio,
      contentType: response.headers.get('content-type') ?? 'audio/wav',
    });
  } catch {
    if (generation === playbackGeneration) {
      spoken.setInterim('');
      if (!controller.signal.aborted)
        speechError = t(M['chat.character_conversation.speech_failed']);
    }
  } finally {
    if (generation === playbackGeneration) {
      playingText = '';
      spoken.setInterim('');
      mounted?.setMouthOpen(0);
      mounted?.setSpeaking?.(false);
    }
  }
}
function toggleSpeech() {
  if (audioEnabled) {
    audioEnabled = false;
    speechError = null;
    stopSpeech();
    return;
  }
  audioEnabled = true;
  speechError = null;
  // Establish the browser audio context while this click still has user activation.
  void Promise.resolve(playback.prepare()).catch(() => {
    if (audioEnabled)
      speechError = t(M['chat.character_conversation.speech_failed']);
  });
}

let ready = $state(false);
let loadGeneration = 0;
async function refreshCharacter() {
  const generation = ++loadGeneration;
  try {
    if (generation !== loadGeneration || !active || !ready) return;
    mounted?.destroy();
    mounted = null;
    unavailable = null;
    const preferences = helperSnapshot?.preferences;
    const offering = helperSnapshot?.offering;
    if (!preferences || !offering || !helperRegistry || !loadHelperPayload) {
      if (helperSnapshot) {
        unavailable = t(helperMessages['chat.helper.open_settings_to_choose']);
        return;
      }
      // Retain the original workbench lifecycle for hosts that have not yet
      // enabled helper preferences.
      const saved = await createDevCharacterPersistenceClient().load();
      if (!saved) {
        unavailable =
          'Save a character in Character setup to bring it into this conversation.';
        return;
      }
      const match = /^data:image\/png;base64,(.+)$/.exec(saved.pngDataUrl);
      if (!match) {
        unavailable = t(helperMessages['chat.helper.load_renderer_failed']);
        return;
      }
      const bytes = Uint8Array.from(atob(match[1]), (value) =>
        value.charCodeAt(0),
      );
      const { mountPhotoCutout } = await import('@happyvertical/animation');
      if (generation !== loadGeneration || !active || !ready) return;
      mounted = mountPhotoCutout(saved.rig, {
        target,
        resolveAsset: async () =>
          new File([bytes], 'saved-character.png', { type: 'image/png' }),
      });
      return;
    }
    const style = helperRegistry.get(offering.styleId);
    if (!style) {
      unavailable = t(helperMessages['chat.helper.selected_style_unavailable']);
      return;
    }
    const payload = await loadHelperPayload(offering);
    if (generation !== loadGeneration || !active || !ready) return;
    const next = await style.mount({
      target,
      offering,
      payload,
    });
    if (generation !== loadGeneration || !active || !ready) {
      next.destroy();
      return;
    }
    mounted = next;
  } catch (error) {
    if (generation === loadGeneration && active && ready)
      unavailable =
        error instanceof Error
          ? error.message
          : t(helperMessages['chat.helper.load_renderer_failed']);
  }
}
function stopSpeech() {
  ++playbackGeneration;
  speechAbort?.abort();
  playingText = '';
  playback.stop();
  spoken.setInterim('');
  mounted?.setMouthOpen(0);
  mounted?.setSpeaking?.(false);
}
$effect(() => {
  helperSnapshot?.preferences?.offeringId;
  helperRegistry;
  loadHelperPayload;
  if (ready && active) void refreshCharacter();
  else {
    ++loadGeneration;
    listening = false;
    stopSpeech();
  }
});
onMount(() => {
  ready = true;
  return () => {
    ++loadGeneration;
    stopSpeech();
    playback.destroy();
    spoken.dispose();
    mounted?.destroy();
  };
});
</script>

<section class="character-conversation" class:bottom-left={helperPreferences?.placement === 'bottom-left'} aria-label={t(M['chat.character_conversation.saved_conversation'])}>
  <div class:bottom-left={helperPreferences?.placement === 'bottom-left'} class:bottom-right={helperPreferences?.placement !== 'bottom-left'} class="character-stage" bind:this={target} aria-label={helperPreferences?.name || t(M['chat.character_conversation.saved_character'])}></div>
  {#if helperPreferences}<p class="helper-name">{helperPreferences.name}</p>{/if}
  {#if unavailable}<p role="status">{unavailable}</p>{/if}
  <div class="conversation-controls">
    <Button type="button" variant="secondary" aria-pressed={listening} onclick={toggleListening}>
      {listening ? 'Leave listening mode' : 'Listening mode'}
    </Button>
    <Button type="button" variant="secondary" aria-pressed={audioEnabled} onclick={toggleSpeech}>
      {audioEnabled ? 'Disable spoken replies' : 'Enable spoken replies'}
    </Button>
    {#if listening}<p role="status">{conversationError ?? (conversationReady ? t(M['chat.character_conversation.listening_notice']) : t(helperMessages['chat.helper.opening_assistant']))}</p>{/if}
    {#if speechError}<p role="alert">{speechError}</p>{/if}
  </div>
  {#if listening && active}
    <CharacterConversationVoice onfinal={sendSpokenTurn} heardSubtitles={helperPreferences?.heardSubtitles ?? true} disabled={!conversationReady || attentionRequired || turnPending} />
  {/if}
  {#if listening && latestReply}
    <section class="latest-reply" aria-label={t(M['chat.character_conversation.assistant_reply'])} aria-live={audioEnabled && !speechError ? 'off' : 'polite'}>
      <p>{latestReply}</p>
    </section>
  {/if}
  <FloatingAssistant bind:expanded={assistantExpanded} visible={active} hideIdleControls={listening} placement={helperPreferences?.placement ?? 'bottom-right'} composerDisabled={turnPending} {registry} {transport} {actionClient} presentation={listening ? 'controls' : 'full'} contextMode="server" launcherLabel="Talk to your assistant" panelLabel="Character assistant" oncontroller={connect} onattentionchange={(required) => (attentionRequired = required)} />
  <SpokenCaptions placement="inline" enabled={helperPreferences?.spokenSubtitles ?? true} lines={spoken.lines} interim={spoken.interim} />
</section>

<style>
  /* The dock is a fixed bottom-corner surface. Keep the listening composer
     above its launcher/closed bar so a pointer can reach Submit. */
  .character-conversation { position: relative; min-block-size: 18rem; padding-block-end: 10rem; }
  .character-stage { min-block-size: 16rem; inline-size: min(18rem, 48vw); margin: 0 auto; }
  .character-stage.bottom-left { margin-inline: 0 auto; }
  .character-stage.bottom-right { margin-inline: auto 0; }
  .helper-name { margin: 0; text-align: center; font-weight: var(--smrt-typography-weight-semibold, 600); }
  .conversation-controls { display: grid; justify-items: center; gap: .5rem; }
  .latest-reply { margin-block: var(--smrt-spacing-3); }
  .latest-reply p { margin: 0; }
  .character-conversation.bottom-left .conversation-controls { justify-items: start; }
  .character-stage :global(canvas), .character-stage :global(svg) { inline-size: 100%; block-size: 100%; }
  @media (min-width: 48rem) {
    .character-conversation { padding-inline-end: 30rem; }
    .character-conversation.bottom-left {
      padding-inline-start: 30rem;
      padding-inline-end: 0;
    }
    .character-conversation :global(.character-conversation-voice) {
      inline-size: min(100%, calc(100vw - 32rem));
    }
  }
  @media (max-width: 47.99rem) {
    /* An expanded dock can fill the lower phone viewport; preserve a scroll
       lane above it for the voice composer rather than letting it be covered. */
    .character-conversation { padding-block-end: min(42rem, calc(100dvh - 4rem)); }
  }
</style>
