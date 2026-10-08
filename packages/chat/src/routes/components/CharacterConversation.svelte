<script lang="ts">
import {
  mountPhotoCutout,
  type PhotoCutoutHandle,
} from '@happyvertical/animation';
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
import { createCaptionChannel } from '../../svelte/components/assistant/captions/caption-state.svelte.js';
import SpokenCaptions from '../../svelte/components/assistant/captions/SpokenCaptions.svelte';
import type {
  AssistantActionClient,
  AssistantDockController,
} from '../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';
import FloatingAssistant from '../../svelte/components/assistant/FloatingAssistant.svelte';
import { M } from '../../svelte/i18n.js';
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
}
let { workbenchAction, active = true }: Props = $props();

let target: HTMLDivElement;
let mounted: PhotoCutoutHandle | null = null;
let unavailable = $state<string | null>(null);
let listening = $state(false);
let audioEnabled = $state(false);
let controller = $state.raw<AssistantDockController | null>(null);
let conversationReady = $state(false);
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
    mounted?.setExpression({
      headTiltDegrees: gain * 5,
      jawTiltDegrees: gain * 7,
    });
    mounted?.setMouthOpen(gain);
  },
});
let playbackGeneration = 0;
let speechAbort: AbortController | null = null;
const transport = createDevAssistantTransport(
  fetch,
  (reply) => {
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
  void owned
    .openThread('dev-character-conversation')
    .then(() => (conversationReady = true));
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
    const response = await fetch('/api/dev-character-speech', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || generation !== playbackGeneration) return;
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
    if (generation === playbackGeneration) spoken.setInterim('');
  } finally {
    if (generation === playbackGeneration) {
      playingText = '';
      spoken.setInterim('');
      mounted?.setMouthOpen(0);
      mounted?.setExpression({ headTiltDegrees: 0, jawTiltDegrees: 0 });
    }
  }
}
function enableSpeech() {
  audioEnabled = true;
  // Establish the browser audio context while this click still has user activation.
  void playback.prepare();
}

let ready = $state(false);
let loadGeneration = 0;
async function refreshCharacter() {
  const generation = ++loadGeneration;
  try {
    const saved = await createDevCharacterPersistenceClient().load();
    if (generation !== loadGeneration || !active || !ready) return;
    mounted?.destroy();
    mounted = null;
    unavailable = null;
    if (!saved) {
      unavailable =
        'Save a character in Character setup to bring it into this conversation.';
      return;
    }
    const match = /^data:image\/png;base64,(.+)$/.exec(saved.pngDataUrl);
    if (!match) {
      unavailable = 'The saved character image is unavailable.';
      return;
    }
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    const asset = new File([bytes], 'saved-character.png', {
      type: 'image/png',
    });
    mounted = mountPhotoCutout(saved.rig, {
      target,
      resolveAsset: async () => asset,
      onError: (error) => {
        if (generation === loadGeneration) unavailable = error.message;
      },
    });
  } catch (error) {
    if (generation === loadGeneration && active && ready)
      unavailable =
        error instanceof Error
          ? error.message
          : 'Saved character could not load.';
  }
}
function stopSpeech() {
  ++playbackGeneration;
  speechAbort?.abort();
  playingText = '';
  playback.stop();
  spoken.setInterim('');
  mounted?.setMouthOpen(0);
  mounted?.setExpression({ headTiltDegrees: 0, jawTiltDegrees: 0 });
}
$effect(() => {
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

<section class="character-conversation" aria-label={t(M['chat.character_conversation.saved_conversation'])}>
  <div class="character-stage" bind:this={target} aria-label={t(M['chat.character_conversation.saved_character'])}></div>
  {#if unavailable}<p role="status">{unavailable}</p>{/if}
  <div class="conversation-controls">
    <Button type="button" variant="secondary" aria-pressed={listening} onclick={() => (listening = !listening)}>
      {listening ? 'Leave listening mode' : 'Listening mode'}
    </Button>
    <Button type="button" variant="secondary" aria-pressed={audioEnabled} onclick={enableSpeech}>
      {audioEnabled ? 'Speech enabled' : 'Enable spoken replies'}
    </Button>
    {#if listening}<p role="status">{t(M['chat.character_conversation.listening_notice'])}</p>{/if}
  </div>
  {#if listening && active}
    <CharacterConversationVoice onfinal={sendSpokenTurn} disabled={!conversationReady || attentionRequired || turnPending} />
  {/if}
  <FloatingAssistant composerDisabled={turnPending} {registry} {transport} {actionClient} presentation={listening ? 'controls' : 'full'} contextMode="server" launcherLabel="Talk to your assistant" panelLabel="Character assistant" oncontroller={connect} onattentionchange={(required) => (attentionRequired = required)} />
  <SpokenCaptions enabled={true} lines={spoken.lines} interim={spoken.interim} />
</section>

<style>
  /* The dock is a fixed bottom-corner surface. Keep the listening composer
     above its launcher/closed bar so a pointer can reach Submit. */
  .character-conversation { position: relative; min-block-size: 18rem; padding-block-end: 10rem; }
  .character-stage { min-block-size: 16rem; inline-size: min(18rem, 48vw); margin: 0 auto; }
  .conversation-controls { display: grid; justify-items: center; gap: .5rem; }
  .character-stage :global(canvas), .character-stage :global(svg) { inline-size: 100%; block-size: 100%; }
  @media (min-width: 48rem) {
    .character-conversation { padding-inline-end: 30rem; }
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
