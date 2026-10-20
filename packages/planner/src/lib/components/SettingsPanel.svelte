<script lang="ts">
import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import type {
  PlannerProjectPersistence,
  PlannerProps,
} from '../planner/types.ts';
import { workspacePersistence } from '../planner/workspace.svelte.ts';
import type { AppSettings as Settings } from '../settings/app-settings.ts';
import AppSettings from './AppSettings.svelte';
import ProjectControls from './ProjectControls.svelte';

interface Props
  extends Pick<PlannerProps, 'controller' | 'onreset' | 'resetDisabledReason'> {
  nativeAssistant?: BrowserAssistantTransport;
  projectPersistence?: PlannerProjectPersistence | null;
}
let {
  controller,
  nativeAssistant,
  onreset,
  resetDisabledReason,
  projectPersistence = workspacePersistence,
}: Props = $props();

// The editor holds its own copy so typing is never fought by the store;
// changes reach the cookbook after a short pause (and its save follows).
const DELAY_MS = 300;
let draft = $state<Settings>(cookbookStore.settings());
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = cookbookStore.replacementGeneration;

function change(next: Settings) {
  draft = next;
  clearTimeout(timer);
  timer = setTimeout(commit, DELAY_MS);
}

function commit() {
  if (generation !== cookbookStore.replacementGeneration) {
    clearTimeout(timer);
    timer = undefined;
    generation = cookbookStore.replacementGeneration;
    draft = cookbookStore.settings();
    return;
  }
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  cookbookStore.setSettings(draft);
}

// A cookbook, import or reset replaces the cookbook: show what it holds.
$effect(() => {
  const nextGeneration = cookbookStore.replacementGeneration;
  const stored = cookbookStore.settings();
  if (generation !== nextGeneration) {
    clearTimeout(timer);
    timer = undefined;
    generation = nextGeneration;
    draft = stored;
  } else if (timer === undefined) draft = stored;
});
</script>

<div class="pane">
  <ProjectControls {projectPersistence} {controller} {nativeAssistant} {onreset} {resetDisabledReason} />
  <p class="meta">
    Defaults for this app. They apply to new records only; existing records
    keep their values.
  </p>
  <AppSettings value={draft} onchange={change} idPrefix="app-settings-tab" />
</div>

<svelte:window onpagehide={commit} />

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .pane {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .meta {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
