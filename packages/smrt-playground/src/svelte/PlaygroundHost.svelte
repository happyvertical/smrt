<script lang="ts">
import { ThemeProvider } from '@happyvertical/smrt-svelte/themes';
import type { Component } from 'svelte';
import { mergePlaygroundModules } from '../runtime.js';
import type {
  PlaygroundComponentModule,
  ResolvedSmrtPlaygroundEntry,
  SmrtPlaygroundMode,
  SmrtPlaygroundModule,
} from '../types.js';

export interface Props {
  modules?: SmrtPlaygroundModule[];
  title?: string;
  subtitle?: string;
}

let {
  modules = [],
  title = 'SMRT Playground',
  subtitle = 'Shared package previews with app-local overrides',
}: Props = $props();

const normalizedModules = $derived(mergePlaygroundModules(modules));
const filteredModules = $derived(
  normalizedModules.filter((module) => {
    if (!searchTerm) {
      return true;
    }

    const query = searchTerm.toLowerCase();
    return (
      module.displayName.toLowerCase().includes(query) ||
      module.entries.some(
        (entry) =>
          entry.title.toLowerCase().includes(query) ||
          entry.id.toLowerCase().includes(query),
      )
    );
  }),
);

let selectedModuleName = $state<string | null>(null);
let selectedEntryId = $state<string | null>(null);
let selectedMode = $state<SmrtPlaygroundMode>('mock');
let searchTerm = $state('');

$effect(() => {
  const firstModule = filteredModules[0] ?? normalizedModules[0] ?? null;
  if (!firstModule) {
    selectedModuleName = null;
    selectedEntryId = null;
    return;
  }

  const activeModule =
    filteredModules.find(
      (module) => module.packageName === selectedModuleName,
    ) ||
    normalizedModules.find(
      (module) => module.packageName === selectedModuleName,
    ) ||
    firstModule;

  if (activeModule.packageName !== selectedModuleName) {
    selectedModuleName = activeModule.packageName;
  }

  const activeEntry =
    activeModule.entries.find(
      (entry) => entry.qualifiedId === selectedEntryId,
    ) ||
    activeModule.entries[0] ||
    null;

  if (activeEntry && activeEntry.qualifiedId !== selectedEntryId) {
    selectedEntryId = activeEntry.qualifiedId;
  }

  if (activeEntry && !activeEntry.availableModes.includes(selectedMode)) {
    selectedMode = activeEntry.availableModes[0] ?? 'mock';
  }
});

const selectedModule = $derived(
  normalizedModules.find(
    (module) => module.packageName === selectedModuleName,
  ) ||
    normalizedModules[0] ||
    null,
);

const selectedEntry = $derived(
  selectedModule?.entries.find(
    (entry) => entry.qualifiedId === selectedEntryId,
  ) ||
    selectedModule?.entries[0] ||
    null,
);

let PreviewComponent = $state<Component<Record<string, unknown>> | null>(null);
let previewLoadError = $state<string | null>(null);
let previewIsLoading = $state(false);

const selectedProps = $derived(
  selectedEntry
    ? {
        ...(selectedEntry.props || {}),
        ...(selectedEntry.modes[selectedMode]?.props || {}),
      }
    : {},
);

function resolvePreviewComponent(
  loaded: PlaygroundComponentModule,
): Component<Record<string, unknown>> {
  if (
    loaded &&
    typeof loaded === 'object' &&
    'default' in loaded &&
    loaded.default
  ) {
    return loaded.default as Component<Record<string, unknown>>;
  }

  return loaded as Component<Record<string, unknown>>;
}

$effect(() => {
  const entry = selectedEntry;
  let cancelled = false;

  previewLoadError = null;

  if (!entry) {
    PreviewComponent = null;
    previewIsLoading = false;
    return;
  }

  if (entry.component) {
    PreviewComponent = entry.component as Component<Record<string, unknown>>;
    previewIsLoading = false;
    return;
  }

  if (!entry.loadComponent) {
    PreviewComponent = null;
    previewIsLoading = false;
    previewLoadError = 'This preview does not declare a renderable component.';
    return;
  }

  PreviewComponent = null;
  previewIsLoading = true;

  void entry
    .loadComponent()
    .then((loaded) => {
      if (cancelled) {
        return;
      }

      PreviewComponent = resolvePreviewComponent(loaded);
      previewIsLoading = false;
    })
    .catch((error) => {
      if (cancelled) {
        return;
      }

      previewLoadError =
        error instanceof Error ? error.message : 'Failed to load preview.';
      previewIsLoading = false;
    });

  return () => {
    cancelled = true;
  };
});

function selectModule(packageName: string) {
  selectedModuleName = packageName;
  selectedEntryId = null;
}

function selectEntry(entry: ResolvedSmrtPlaygroundEntry) {
  selectedModuleName = entry.packageName;
  selectedEntryId = entry.qualifiedId;
  selectedMode = entry.availableModes[0] ?? 'mock';
}
</script>

<ThemeProvider colorScheme="system" persist={true}>
  <div class="playground-shell">
    <aside class="sidebar">
      <div class="sidebar__header">
        <p class="eyebrow">Shared Host</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>

      <label class="search">
        <span>Filter previews</span>
        <input bind:value={searchTerm} placeholder="Search packages or entries" />
      </label>

      <div class="module-list">
        {#if filteredModules.length === 0}
          <div class="empty-card">
            <strong>No previews found</strong>
            <p>Add a `src/svelte/playground.ts` file to a package, or scaffold `src/playground.ts` in your app.</p>
          </div>
        {:else}
          {#each filteredModules as module (module.packageName)}
            <button
              type="button"
              class:selected={module.packageName === selectedModule?.packageName}
              onclick={() => selectModule(module.packageName)}
            >
              <strong>{module.displayName}</strong>
              <span>{module.entries.length} preview{module.entries.length === 1 ? '' : 's'}</span>
            </button>
          {/each}
        {/if}
      </div>
    </aside>

    <main class="content">
      {#if selectedModule}
        <header class="content__header">
          <div>
            <p class="eyebrow">{selectedModule.packageName}</p>
            <h2>{selectedModule.displayName}</h2>
            {#if selectedModule.description}
              <p>{selectedModule.description}</p>
            {/if}
          </div>
        </header>

        <div class="content__body">
          <section class="entry-list">
            {#each selectedModule.entries as entry (entry.qualifiedId)}
              <button
                type="button"
                class:selected={entry.qualifiedId === selectedEntry?.qualifiedId}
                onclick={() => selectEntry(entry)}
              >
                <div>
                  <strong>{entry.title}</strong>
                  <span>{entry.id}</span>
                </div>
                <div class="mode-pills">
                  {#each entry.availableModes as mode}
                    <span>{mode}</span>
                  {/each}
                </div>
              </button>
            {/each}
          </section>

          <section class="preview-panel">
            {#if selectedEntry && PreviewComponent}
              <div class="preview-panel__meta">
                <div>
                  <h3>{selectedEntry.title}</h3>
                  {#if selectedEntry.description}
                    <p>{selectedEntry.description}</p>
                  {/if}
                </div>

                {#if selectedEntry.availableModes.length > 1}
                  <div class="mode-toggle" role="group" aria-label="Preview mode">
                    {#each selectedEntry.availableModes as mode}
                      <button
                        type="button"
                        class:active={mode === selectedMode}
                        aria-pressed={mode === selectedMode}
                        onclick={() => (selectedMode = mode)}
                      >
                        {mode}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>

              <div class="preview-stage">
                <PreviewComponent {...selectedProps} />
              </div>
            {:else if selectedEntry && previewIsLoading}
              <div class="empty-card">
                <strong>Loading preview...</strong>
                <p>{selectedEntry.title} is being loaded for the selected mode.</p>
              </div>
            {:else if selectedEntry && previewLoadError}
              <div class="empty-card">
                <strong>Preview failed to load</strong>
                <p>{previewLoadError}</p>
              </div>
            {:else}
              <div class="empty-card">
                <strong>No preview selected</strong>
                <p>Select a preview entry from the left to render it.</p>
              </div>
            {/if}
          </section>
        </div>
      {:else}
        <div class="empty-card full-height">
          <strong>No playground modules discovered</strong>
          <p>The shared host is ready, but nothing is exporting playground entries yet.</p>
        </div>
      {/if}
    </main>
  </div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    font-family:
      "IBM Plex Sans",
      "Inter",
      system-ui,
      sans-serif;
    background:
      radial-gradient(circle at top left, rgba(30, 96, 145, 0.16), transparent 28rem),
      linear-gradient(180deg, #f4f7fb 0%, #eef2f8 100%);
    color: #0f1722;
    min-height: 100vh;
  }

  .playground-shell {
    display: grid;
    grid-template-columns: 20rem minmax(0, 1fr);
    min-height: 100vh;
  }

  .sidebar {
    display: grid;
    align-content: start;
    gap: 1.25rem;
    padding: 1.5rem;
    background: rgba(7, 15, 26, 0.92);
    color: #ecf2ff;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(18px);
  }

  .sidebar__header h1,
  .content__header h2,
  .preview-panel__meta h3 {
    margin: 0;
  }

  .sidebar__header,
  .search,
  .module-list,
  .content,
  .content__body,
  .entry-list,
  .preview-panel {
    display: grid;
    gap: 0.9rem;
  }

  .eyebrow {
    margin: 0 0 0.35rem;
    font-size: 0.75rem;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #6aa4ff;
  }

  .sidebar__header p:last-child,
  .content__header p,
  .preview-panel__meta p,
  .empty-card p {
    margin: 0;
    line-height: 1.55;
  }

  .search span {
    font-size: 0.82rem;
    color: rgba(236, 242, 255, 0.72);
  }

  .search input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 0.9rem;
    background: rgba(255, 255, 255, 0.08);
    color: inherit;
    padding: 0.8rem 0.95rem;
  }

  .module-list button,
  .entry-list button,
  .mode-toggle button {
    border: 0;
    cursor: pointer;
    transition:
      transform 140ms ease,
      background 140ms ease,
      border-color 140ms ease;
  }

  .module-list button,
  .entry-list button {
    display: grid;
    gap: 0.25rem;
    text-align: left;
    padding: 0.9rem 1rem;
    border-radius: 1rem;
  }

  .module-list button {
    background: rgba(255, 255, 255, 0.06);
    color: inherit;
    border: 1px solid transparent;
  }

  .module-list button.selected,
  .module-list button:hover {
    background: rgba(106, 164, 255, 0.14);
    border-color: rgba(106, 164, 255, 0.34);
  }

  .module-list button span,
  .entry-list button span {
    font-size: 0.82rem;
    opacity: 0.78;
  }

  .content {
    padding: 1.75rem;
    align-content: start;
  }

  .content__body {
    grid-template-columns: 18rem minmax(0, 1fr);
    align-items: start;
  }

  .entry-list button {
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(15, 23, 34, 0.08);
    box-shadow: 0 18px 45px rgba(15, 23, 34, 0.05);
  }

  .entry-list button.selected,
  .entry-list button:hover {
    transform: translateY(-1px);
    border-color: rgba(14, 93, 224, 0.25);
    box-shadow: 0 18px 45px rgba(14, 93, 224, 0.12);
  }

  .mode-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .mode-pills span,
  .mode-toggle button {
    border-radius: 999px;
    padding: 0.25rem 0.6rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .mode-pills span {
    background: rgba(14, 93, 224, 0.08);
    color: #0e5de0;
  }

  .preview-panel,
  .empty-card {
    padding: 1.1rem;
    border-radius: 1.25rem;
    background: rgba(255, 255, 255, 0.82);
    border: 1px solid rgba(15, 23, 34, 0.08);
    box-shadow: 0 24px 60px rgba(15, 23, 34, 0.08);
    backdrop-filter: blur(18px);
  }

  .preview-panel__meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }

  .mode-toggle {
    display: inline-flex;
    gap: 0.45rem;
    padding: 0.2rem;
    border-radius: 999px;
    background: #e6edf9;
  }

  .mode-toggle button {
    background: transparent;
    color: #36527b;
  }

  .mode-toggle button.active {
    background: #0e5de0;
    color: white;
  }

  .preview-stage {
    padding: 1rem;
    border-radius: 1rem;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(245, 248, 252, 0.94)),
      radial-gradient(circle at top, rgba(106, 164, 255, 0.12), transparent 28rem);
    border: 1px solid rgba(15, 23, 34, 0.06);
    overflow: auto;
    min-height: 24rem;
  }

  .full-height {
    min-height: 60vh;
    align-content: center;
  }

  @media (max-width: 1040px) {
    .playground-shell,
    .content__body {
      grid-template-columns: 1fr;
    }
  }
</style>
