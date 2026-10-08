<script lang="ts">
import type {
  STTAdapter,
  TTSAdapter,
} from '@happyvertical/smrt-svelte/browser-ai';
import {
  createDataSurfaceRegistry,
  type DataSurfaceIdentity,
} from '@happyvertical/smrt-ui/data-surface';
import {
  Checkbox,
  Dictation,
  DictationButton,
  DictationStatus,
  Input,
} from '@happyvertical/smrt-ui/forms';
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import '@happyvertical/smrt-ui/themes/styles/all.css';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import { createInMemoryAssistantTransport } from '../../../svelte/components/assistant/assistant-transport.js';
import CaptionOverlay from '../../../svelte/components/assistant/captions/CaptionOverlay.svelte';
import {
  createCaptionChannel,
  createHeardCaptionCallbacks,
  createSpokenCaptionSession,
} from '../../../svelte/components/assistant/captions/caption-state.svelte.js';
import HeardCaptions from '../../../svelte/components/assistant/captions/HeardCaptions.svelte';
import SpokenCaptions from '../../../svelte/components/assistant/captions/SpokenCaptions.svelte';
import type { AssistantDockController } from '../../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';
import FloatingAssistant from '../../../svelte/components/assistant/FloatingAssistant.svelte';
import {
  createSyntheticPlayback,
  createSyntheticSpeechSource,
  MockAssistantActionClient,
} from './fixture.js';

const heard = createCaptionChannel('heard', { maxLines: 3 });
const spoken = createCaptionChannel('spoken', { maxLines: 2 });
const heardCallbacks = createHeardCaptionCallbacks(heard);
const speech = createSyntheticSpeechSource();
const playback = createSyntheticPlayback();
let speaking = createSpokenCaptionSession(playback.adapter, spoken);
let realMicrophone = $state(false);
let sourceLocked = $state(false);
let realSpeech: STTAdapter | undefined;
let realPlayback: TTSAdapter | undefined;
let heardEnabled = $state(true);
let spokenEnabled = $state(true);
let listeningMode = $state(true);
let ready = $state(false);
let sending = $state(false);
let notice = $state('Start listening to use the synthetic speech controls.');
let projectStatus = $state('pending');
let revision = $state(1);
let sentTurns = $state(0);
let controller = $state<AssistantDockController>();
let disposed = false;
let requestSequence = 0;

const identity: DataSurfaceIdentity = {
  surfaceId: 'listening-project',
  kind: 'table',
  subject: { type: 'tenant', id: 'demo-tenant' },
};
const registry = createDataSurfaceRegistry();
const unregister = registry.register({
  descriptor: {
    version: 1,
    identity,
    schemaVersion: 1,
    label: 'Project status',
    rowKey: 'id',
    columns: [
      {
        id: 'id',
        label: 'Project',
        capabilities: ['read', 'project'],
        role: 'row-key',
      },
      { id: 'status', label: 'Status', capabilities: ['read', 'project'] },
    ],
    query: {
      modes: ['rows'],
      projectableColumnIds: ['id', 'status'],
      searchableColumnIds: [],
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    actions: [
      {
        id: 'set-status',
        label: 'Mark project ready',
        selectionScopes: ['explicit-ids'],
        requiresConfirmation: true,
      },
    ],
    controls: [
      { id: 'data-surface.action.set-status', label: 'Mark project ready' },
    ],
    limits: { maxQueryRows: 1, maxQueryBytes: 1000, maxSelectionSize: 1 },
  },
  getSnapshot: () => ({
    revision,
    state: { rows: [{ id: 'project-1', status: projectStatus }] },
  }),
  execute: async (command) => {
    const payload = command.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.status !== 'ready' ||
      payload.rowId !== 'project-1'
    ) {
      return { ok: false, reason: 'not_found' };
    }
    projectStatus = 'ready';
    revision++;
  },
});
const actionClient = new MockAssistantActionClient(registry, () => revision);
const reply =
  'I can mark the project ready. Review the change before I apply it.';
const isProjectRequest = (text: string) =>
  /mark (?:the )?project ready/i.test(text);
const transport = createInMemoryAssistantTransport({
  respond: (threadId, message) => ({
    id: `reply-${++requestSequence}`,
    threadId,
    content: isProjectRequest(message.content)
      ? reply
      : 'Try saying: mark the project ready.',
    role: 'assistant',
    createdAt: new Date(),
  }),
});
const approvalPending = $derived(
  Boolean(
    controller &&
      (controller.toolRequests.some(
        (request) => request.status === 'waiting',
      ) ||
        [...controller.actions.values()].some(
          (action) =>
            action.status === 'previewing' ||
            action.status === 'previewed' ||
            action.status === 'applying' ||
            action.outcomeUnknown,
        )),
  ),
);

// This is the only Dictation. The button and both caption/draft callbacks use
// the same speech source; this fixture deliberately never acquires a mic.
const dictation = new Dictation({
  source: async () => {
    sourceLocked = true;
    if (!realMicrophone) return speech.source;
    const { createSttDictationSource, BrowserSynthesisTTSAdapter } =
      await import('@happyvertical/smrt-svelte/browser-ai');
    const source = await createSttDictationSource()();
    if (disposed) {
      await source.dispose();
      throw new Error('Listening workbench closed');
    }
    realSpeech = source;
    realPlayback = new BrowserSynthesisTTSAdapter();
    speaking.dispose();
    speaking = createSpokenCaptionSession(realPlayback, spoken);
    return source;
  },
  requestMicrophone: false,
  beep: false,
  onInterim: heardCallbacks.onInterim,
  onText(text) {
    heardCallbacks.onText(text);
    void sendFinal(text);
  },
});

$effect(() => {
  if (dictation.state === 'idle' || dictation.state === 'error') {
    heard.setInterim('');
  }
});

async function connect(next: AssistantDockController) {
  controller = next;
  try {
    const thread = await next.createThread('Listening demo');
    if (disposed) return;
    await next.openThread(thread.id);
    if (!disposed) ready = true;
  } catch (error) {
    notice = error instanceof Error ? error.message : String(error);
  }
}

async function sendFinal(text: string) {
  if (!controller || !ready || sending || disposed) return;
  if (approvalPending || controller.draft.trim()) {
    notice =
      'Review the pending action or finish the existing draft before another voice turn.';
    return;
  }
  sending = true;
  const current = controller;
  try {
    current.setDraft(text);
    await current.send(text);
    if (disposed) return;
    sentTurns++;
    if (!isProjectRequest(text)) {
      notice = 'Try saying: mark the project ready.';
      return;
    }
    await current.previewAction({
      version: 1,
      requestId: `proposal-${++requestSequence}`,
      identity,
      actionId: 'set-status',
      phase: 'preview',
      selection: { scope: 'explicit-ids', rowIds: ['project-1'] },
      payload: { rowId: 'project-1', status: 'ready' },
    });
    if (disposed) return;
    notice =
      'The project stays unchanged until you confirm. Speech cannot approve it.';
    void speaking.speak(reply).catch((error) => {
      notice = error instanceof Error ? error.message : String(error);
    });
  } catch (error) {
    current.setError(error instanceof Error ? error.message : String(error));
  } finally {
    sending = false;
  }
}

onDestroy(() => {
  disposed = true;
  dictation.dispose();
  void realSpeech?.dispose();
  void realPlayback?.dispose();
  heard.dispose();
  speaking.dispose();
  unregister();
});
</script>

<svelte:head><title>Listening mode fixture</title></svelte:head>

<ThemeProvider preset="material" colorScheme="light">
<main>
  <h1>Watch the app, talk to your assistant</h1>
  <p>Starts with synthetic voice and playback events. To talk to the app, choose Real microphone before starting and say “Mark the project ready.” Browser speech support is required.</p>
  <section class="app" aria-label="Observed application">
    <h2>Project status</h2>
    <Input aria-label="Project name" value="Listening demo" readonly />
    <Input aria-label="Project status" value={projectStatus} readonly />
    <p>Application revision: <output data-testid="revision">{revision}</output></p>
  </section>
  <section class="controls" aria-label="Caption controls">
    <Checkbox bind:checked={heardEnabled} label="Show what I said" />
    <Checkbox bind:checked={spokenEnabled} label="Show assistant speech" />
    <Checkbox bind:checked={listeningMode} label="Hide conversation history" />
  </section>
  <Checkbox bind:checked={realMicrophone} disabled={sourceLocked} label="Real microphone and browser speech (opt in)" />
  <p>{realMicrophone ? 'The Start listening button requests browser speech access. Browser speech may use its speech service.' : 'Synthetic mode: no microphone, provider, or audio device.'} Reload to change voice source after starting.</p>
  <section class="controls" aria-label="Voice controls">
    <DictationButton {dictation} disabled={!ready} label="Start listening" stopLabel="Stop listening" title={realMicrophone ? "Start browser speech recognition" : "Start the synthetic speech source"} />
    <DictationStatus {dictation} />
    <Button disabled={!ready || realMicrophone} onclick={() => speech.emit('Mark the project', false)}>Synthetic interim</Button>
    <Button disabled={!ready || realMicrophone} onclick={() => speech.emit('Mark the project ready.', true)}>Synthetic final</Button>
    <Button disabled={realMicrophone} onclick={() => playback.start()}>Playback started</Button>
    <Button disabled={realMicrophone} onclick={() => playback.boundary()}>Playback boundary</Button>
    <Button disabled={realMicrophone} onclick={() => playback.end()}>Playback ended</Button>
    <Button onclick={() => speaking.stop()}>Stop playback</Button>
  </section>
  <p role="status">{notice}</p>
  <p>Sent turns: <output data-testid="sent-turns">{sentTurns}</output></p>
  <CaptionOverlay>
    <HeardCaptions enabled={heardEnabled} lines={heard.lines} interim={heard.interim} placement="bottom" />
    <SpokenCaptions enabled={spokenEnabled} lines={spoken.lines} interim={spoken.interim} placement="bottom" />
  </CaptionOverlay>
  <FloatingAssistant {transport} {registry} {actionClient} presentation={listeningMode ? 'controls' : 'full'} oncontroller={connect} launcherLabel="Open listening assistant" />
</main>
</ThemeProvider>

<style>
  main { max-inline-size: 60rem; font-family: var(--smrt-font-family, system-ui, sans-serif); color: var(--smrt-color-on-surface, #172033); margin: 2rem auto; padding: 1rem 1rem 6rem; }
  .controls { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; margin-block: 1rem; }
  .app { display: grid; gap: .75rem; border: 1px solid var(--smrt-color-outline, currentColor); padding: 1rem; border-radius: var(--smrt-radius-medium, .5rem); }
  h1 { font-size: clamp(1.5rem, 4vw, 2.5rem); }
  @media (min-width: 48rem) {
    main { padding-inline-end: 30rem; }
  }
</style>
