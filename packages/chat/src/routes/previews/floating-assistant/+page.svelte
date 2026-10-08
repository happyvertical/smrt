<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { AssistantDockController } from '../../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';
import FloatingAssistant from '../../../svelte/components/assistant/FloatingAssistant.svelte';
import { createFloatingFixture } from './fixture.js';

const fixture = createFloatingFixture();
let controller: AssistantDockController | undefined = $state();
let mounts = $state(0);
let expanded = $state(false);
let visible = $state(true);
let evidence = $state('');
function refreshEvidence() {
  evidence = JSON.stringify(fixture.evidence);
}
async function send(content: string) {
  await controller?.openThread('preview-thread');
  await controller?.send(content);
  refreshEvidence();
}
</script>

<svelte:head>
  <title>Floating assistant preview</title>
</svelte:head>

<ThemeProvider colorScheme="light">
  <main>
    <h1>Floating assistant</h1>
    <p>
      This mock transport uses the same permanently mounted dock as production;
      collapse and reopen it while keeping the conversation state alive.
    </p>
    <Button onclick={() => void controller?.openThread('preview-thread')}>Open preview conversation</Button>
    <Button onclick={() => { visible = false; }}>Hide assistant</Button>
    <Button onclick={() => { visible = true; }}>Show assistant</Button>
    <Button onclick={() => void send('tool')}>Request tool</Button>
    <Button onclick={() => void controller?.previewAction(fixture.proposal())}>Preview action</Button>
    <Button onclick={() => { expanded = false; }}>Host closes panel</Button>
    <Button onclick={() => void send('choices')}>Offer choices</Button>
    <Button onclick={() => void send('work')}>Start work</Button>
    <Button onclick={() => controller?.setError('Preview failure remains visible')}>Show error</Button>
    <Button onclick={refreshEvidence}>Inspect decisions</Button>
    <output aria-label="Decision evidence">{evidence}</output>
    <output aria-label="Controller mounts">{mounts}</output>
  </main>
  <FloatingAssistant
    {...fixture}
    bind:expanded
    {visible}
    presentation="controls"
    contextMode="server"
    oncontroller={(owned) => { controller = owned; mounts += 1; }}
  />
</ThemeProvider>

<style>
  main {
    max-inline-size: 42rem;
    margin: 3rem auto;
    padding: 1rem;
    font-family: var(--smrt-font-family, system-ui, sans-serif);
  }
</style>
