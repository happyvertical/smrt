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
import CharacterConversationVoice from './CharacterConversationVoice.svelte';

let target: HTMLDivElement;
let mounted: PhotoCutoutHandle | null = null;
let unavailable = $state<string | null>(null);
let listening = $state(false);
let audioEnabled = $state(false);
let controller: AssistantDockController | null = null;
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
    actions: [],
    controls: [],
    limits: { maxQueryRows: 1, maxQueryBytes: 1024, maxSelectionSize: 1 },
  },
  getSnapshot: () => ({ revision: 1, state: {} }),
});
const actionClient: AssistantActionClient = {
  preview: async (request) => actionResult(request, 'preview'),
  apply: async (request) => {
    const payload =
      request.payload &&
      typeof request.payload === 'object' &&
      !Array.isArray(request.payload)
        ? request.payload
        : {};
    if (request.actionId === 'navigate')
      workbenchAction?.navigate?.(String(payload.section ?? 'conversation'));
    if (request.actionId === 'stage-draft')
      workbenchAction?.stageDraft?.(String(payload.value ?? ''));
    return actionResult(request, 'apply');
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
export interface Props {
  workbenchAction?: {
    navigate?: (section: string) => void;
    stageDraft?: (value: string) => void;
  };
}
let { workbenchAction }: Props = $props();
const spoken = createCaptionChannel('spoken', { ttlMs: 12000 });
let playback = createSpeechPlayback({
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
  void owned.openThread('dev-character-conversation');
}
async function sendSpokenTurn(text: string) {
  if (!controller) throw new Error('Open the assistant before speaking.');
  await controller.send(text);
}

async function speak(reply: string) {
  const text = reply.slice(0, 500);
  const generation = ++playbackGeneration;
  speechAbort?.abort();
  const controller = new AbortController();
  speechAbort = controller;
  playback.stop();
  try {
    if (!audioEnabled) return;
    spoken.setInterim(text);
    const response = await fetch('/api/dev-character-speech', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok || generation !== playbackGeneration) return;
    await playback.play({
      audio: await response.arrayBuffer(),
      contentType: response.headers.get('content-type') ?? 'audio/wav',
    });
    if (generation === playbackGeneration) spoken.addFinal(text);
  } catch {
    if (generation === playbackGeneration) spoken.setInterim('');
  } finally {
    if (generation === playbackGeneration) {
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

onMount(() => {
  let active = true;
  void createDevCharacterPersistenceClient()
    .load()
    .then((saved) => {
      if (!active) return;
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
          unavailable = error.message;
        },
      });
    })
    .catch((error: unknown) => {
      if (active)
        unavailable =
          error instanceof Error
            ? error.message
            : 'Saved character could not load.';
    });
  return () => {
    active = false;
    speechAbort?.abort();
    playback.stop();
    playback.destroy();
    spoken.dispose();
    mounted?.destroy();
  };
});
</script>

<section class="character-conversation" aria-label="Saved character conversation">
  <div class="character-stage" bind:this={target} aria-label="Saved photographic character"></div>
  {#if unavailable}<p role="status">{unavailable}</p>{/if}
  <div class="conversation-controls">
    <Button type="button" variant="secondary" aria-pressed={listening} onclick={() => (listening = !listening)}>
      {listening ? 'Leave listening mode' : 'Listening mode'}
    </Button>
    <Button type="button" variant="secondary" aria-pressed={audioEnabled} onclick={enableSpeech}>
      {audioEnabled ? 'Speech enabled' : 'Enable spoken replies'}
    </Button>
    {#if listening}<p role="status">Listening mode keeps the conversation and confirmations active while hiding message history.</p>{/if}
  </div>
  {#if listening}
    <CharacterConversationVoice onfinal={sendSpokenTurn} />
  {/if}
  <FloatingAssistant {registry} {transport} {actionClient} presentation={listening ? 'controls' : 'full'} contextMode="server" launcherLabel="Talk to your assistant" panelLabel="Character assistant" oncontroller={connect} />
  <SpokenCaptions enabled={true} lines={spoken.lines} interim={spoken.interim} />
</section>

<style>
  .character-conversation { position: relative; min-block-size: 18rem; }
  .character-stage { min-block-size: 16rem; inline-size: min(18rem, 48vw); margin: 0 auto; }
  .conversation-controls { display: grid; justify-items: center; gap: .5rem; }
  .character-stage :global(canvas), .character-stage :global(svg) { inline-size: 100%; block-size: 100%; }
</style>
