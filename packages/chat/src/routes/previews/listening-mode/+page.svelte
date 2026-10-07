<script lang="ts">
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { Button } from '@happyvertical/smrt-ui/ui';
import { createInMemoryAssistantTransport } from '../../../svelte/components/assistant/assistant-transport.js';
import { createCaptionChannel } from '../../../svelte/components/assistant/captions/caption-state.svelte.js';
import HeardCaptions from '../../../svelte/components/assistant/captions/HeardCaptions.svelte';
import SpokenCaptions from '../../../svelte/components/assistant/captions/SpokenCaptions.svelte';
import FloatingAssistant from '../../../svelte/components/assistant/FloatingAssistant.svelte';

// This workbench fixture deliberately uses no microphone, audio device, or
// provider. Its buttons stand in for events from the one host-owned
// Dictation and TTS session described in docs/assistant-captions.md.
const heard = createCaptionChannel('heard', { maxLines: 3, ttlMs: 12_000 });
const spoken = createCaptionChannel('spoken', { maxLines: 2, ttlMs: 12_000 });
let heardEnabled = $state(true);
let spokenEnabled = $state(true);
// The permanent dock retains the real conversation and confirmation UI;
// this route never invents an alternate approval protocol.
const transport = createInMemoryAssistantTransport();
const registry = createDataSurfaceRegistry();

function hearInterim() {
  heard.setInterim('show the latest project status');
}
function hearFinal() {
  heard.addFinal('Show the latest project status.');
}
function playbackStart() {
  spoken.setInterim('I found');
}
function playbackBoundary() {
  spoken.setInterim('I found an action that needs your approval.');
}
function playbackEnd() {
  spoken.addFinal('I found an action that needs your approval.');
}
</script>

<svelte:head><title>Listening mode fixture</title></svelte:head>

<main>
  <h1>Listening mode</h1>
  <p>This fixture keeps the assistant action visible while conversation history is hidden.</p>
  <section aria-label="Caption controls">
    <label><input type="checkbox" bind:checked={heardEnabled} /> Show what I said</label>
    <label><input type="checkbox" bind:checked={spokenEnabled} /> Show assistant speech</label>
    <Button onclick={hearInterim}>Synthetic interim</Button>
    <Button onclick={hearFinal}>Synthetic final</Button>
    <Button onclick={playbackStart}>Playback started</Button>
    <Button onclick={playbackBoundary}>Playback boundary</Button>
    <Button onclick={playbackEnd}>Playback ended</Button>
  </section>
  <section class="app" aria-label="Observed application">
    <h2>Project status</h2><p>Three approvals are waiting.</p>
    <p>The permanent assistant remains available for authorised actions and confirmations.</p>
  </section>
  <HeardCaptions enabled={heardEnabled} lines={heard.lines} interim={heard.interim} placement="inline" />
  <SpokenCaptions enabled={spokenEnabled} lines={spoken.lines} interim={spoken.interim} placement="inline" />
  <FloatingAssistant {transport} {registry} contextMode="server" launcherLabel="Open listening assistant" />
</main>

<style>main{max-inline-size:60rem;margin:2rem auto;padding:1rem}section{display:flex;gap:.75rem;flex-wrap:wrap;margin-block:1rem}.app{display:block;border:1px solid currentColor;padding:1rem}.approval{display:block;border-inline-start:4px solid #754;padding:.75rem}</style>
