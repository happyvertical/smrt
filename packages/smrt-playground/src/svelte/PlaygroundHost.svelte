<script lang="ts">
import {
  ColorSchemeToggle,
  ThemeProvider,
  ThemeSwitcher,
  tryGetThemeContext,
} from '@happyvertical/smrt-ui/themes';
import type { Component } from 'svelte';
import { onMount } from 'svelte';
import { mergePlaygroundModules } from './runtime.js';
import type {
  PlaygroundComponentModule,
  ResolvedSmrtPlaygroundEntry,
  SmrtPlaygroundMode,
  SmrtPlaygroundModule,
} from './types.js';

export interface Props {
  /** Playground modules containing entries to display. */
  modules?: SmrtPlaygroundModule[];
  /** Main heading text. */
  title?: string;
  /** Subtitle or description text. */
  subtitle?: string;
  /** Enables embedded mode which affects UI presentation. */
  embedded?: boolean;
  /**
   * Qualified entry ID controlled by the parent. Clearing a previously
   * controlled selection restores the playground's default selection.
   */
  selectedEntryId?: string | null;
  /** Hides the entry list when true. */
  hideEntryList?: boolean;
}

let {
  modules = [],
  title = 's-m-r-t playground',
  subtitle = 'Shared package previews with app-local overrides',
  embedded = false,
  selectedEntryId: controlledSelectedEntryId = null,
  hideEntryList = false,
}: Props = $props();

const foundationPackageName = '@happyvertical/smrt-ui';
const foundationGroupOrder = [
  'Inputs & controls',
  'Feedback & overlays',
  'Collections & data',
] as const;

let searchTerm = $state('');
let selectedModuleName = $state<string | null>(null);
let selectedEntryId = $state<string | null>(null);
let selectedMode = $state<SmrtPlaygroundMode>('mock');
let isHydrated = $state(false);
let previousControlledSelectedEntryId: string | null = null;
const inheritedThemeContext = tryGetThemeContext();

onMount(() => {
  isHydrated = true;
});

const normalizedModules = $derived(mergePlaygroundModules(modules));
const orderedModules = $derived([
  ...normalizedModules.filter(
    (module) => module.packageName === foundationPackageName,
  ),
  ...normalizedModules.filter(
    (module) => module.packageName !== foundationPackageName,
  ),
]);

const filteredModules = $derived.by(() => {
  const query = searchTerm.trim().toLowerCase();
  if (!query) {
    return orderedModules;
  }

  return orderedModules
    .map((module) => {
      const moduleMatches = [
        module.displayName,
        module.packageName,
        module.description,
      ].some((value) => value?.toLowerCase().includes(query));

      if (moduleMatches) {
        return module;
      }

      return {
        ...module,
        entries: module.entries.filter((entry) =>
          [
            entry.title,
            entry.id,
            entry.description,
            ...(entry.tags ?? []),
          ].some((value) => value?.toLowerCase().includes(query)),
        ),
      };
    })
    .filter((module) => module.entries.length > 0);
});

const filteredFoundation = $derived(
  filteredModules.find(
    (module) => module.packageName === foundationPackageName,
  ) ?? null,
);
const filteredPackageModules = $derived(
  filteredModules.filter(
    (module) => module.packageName !== foundationPackageName,
  ),
);

function foundationGroup(entry: ResolvedSmrtPlaygroundEntry) {
  const tags = entry.tags ?? [];
  if (tags.includes('feedback') || tags.includes('overlays')) {
    return 'Feedback & overlays';
  }
  if (
    tags.some((tag) =>
      ['content', 'data', 'grid', 'list', 'table'].includes(tag),
    )
  ) {
    return 'Collections & data';
  }
  return 'Inputs & controls';
}

const foundationGroups = $derived.by(() => {
  const grouped = new Map<string, ResolvedSmrtPlaygroundEntry[]>();
  for (const entry of filteredFoundation?.entries ?? []) {
    const group = foundationGroup(entry);
    grouped.set(group, [...(grouped.get(group) ?? []), entry]);
  }

  return foundationGroupOrder
    .map((group) => [group, grouped.get(group) ?? []] as const)
    .filter(([, entries]) => entries.length > 0);
});

$effect(() => {
  const controlledSelectionWasCleared =
    previousControlledSelectedEntryId !== null &&
    controlledSelectedEntryId === null;
  previousControlledSelectedEntryId = controlledSelectedEntryId;

  const controlledModule = controlledSelectedEntryId
    ? (orderedModules.find((module) =>
        module.entries.some(
          (entry) => entry.qualifiedId === controlledSelectedEntryId,
        ),
      ) ?? null)
    : null;
  const firstModule = controlledModule ?? orderedModules[0] ?? null;
  if (!firstModule) {
    selectedModuleName = null;
    selectedEntryId = null;
    return;
  }

  if (controlledSelectionWasCleared) {
    selectedModuleName = firstModule.packageName;
    selectedEntryId =
      firstModule.packageName === foundationPackageName || hideEntryList
        ? (firstModule.entries[0]?.qualifiedId ?? null)
        : null;
    selectedMode = firstModule.entries[0]?.availableModes[0] ?? 'mock';
    return;
  }

  const activeModule =
    controlledModule ??
    orderedModules.find(
      (module) => module.packageName === selectedModuleName,
    ) ??
    firstModule;

  if (activeModule.packageName !== selectedModuleName) {
    selectedModuleName = activeModule.packageName;
    selectedEntryId =
      controlledSelectedEntryId ??
      (activeModule.packageName === foundationPackageName || hideEntryList
        ? (activeModule.entries[0]?.qualifiedId ?? null)
        : null);
    selectedMode = activeModule.entries[0]?.availableModes[0] ?? 'mock';
    return;
  }

  const requestedEntryId = controlledSelectedEntryId ?? selectedEntryId;
  if (requestedEntryId === null && !hideEntryList) {
    return;
  }

  const activeEntry =
    activeModule.entries.find(
      (entry) => entry.qualifiedId === requestedEntryId,
    ) ?? (hideEntryList ? (activeModule.entries[0] ?? null) : null);

  if (!activeEntry) {
    selectedEntryId = null;
    return;
  }

  selectedEntryId = activeEntry.qualifiedId;
  if (!activeEntry.availableModes.includes(selectedMode)) {
    selectedMode = activeEntry.availableModes[0] ?? 'mock';
  }
});

const selectedModule = $derived(
  orderedModules.find((module) => module.packageName === selectedModuleName) ??
    orderedModules[0] ??
    null,
);
const selectedEntry = $derived(
  selectedModule?.entries.find(
    (entry) =>
      entry.qualifiedId === (controlledSelectedEntryId ?? selectedEntryId),
  ) ?? (hideEntryList ? (selectedModule?.entries[0] ?? null) : null),
);
const selectedModeConfig = $derived(
  selectedEntry ? (selectedEntry.modes[selectedMode] ?? null) : null,
);
const selectedProps = $derived(
  selectedEntry
    ? {
        ...(selectedEntry.props ?? {}),
        ...(selectedModeConfig?.props ?? {}),
      }
    : {},
);

let PreviewComponent = $state<Component<Record<string, unknown>> | null>(null);
let previewComponentEntryId = $state<string | null>(null);
let previewLoadError = $state<string | null>(null);
let previewIsLoading = $state(false);

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
    previewComponentEntryId = null;
    previewIsLoading = false;
    return;
  }

  if (entry.component) {
    PreviewComponent = entry.component as Component<Record<string, unknown>>;
    previewComponentEntryId = entry.qualifiedId;
    previewIsLoading = false;
    return;
  }

  if (!entry.loadComponent) {
    PreviewComponent = null;
    previewComponentEntryId = null;
    previewIsLoading = false;
    previewLoadError = 'This preview does not declare a renderable component.';
    return;
  }

  PreviewComponent = null;
  previewComponentEntryId = null;
  previewIsLoading = true;

  void entry
    .loadComponent()
    .then((loaded) => {
      if (cancelled) {
        return;
      }
      PreviewComponent = resolvePreviewComponent(loaded);
      previewComponentEntryId = entry.qualifiedId;
      previewIsLoading = false;
    })
    .catch((error) => {
      if (cancelled) {
        return;
      }
      PreviewComponent = null;
      previewComponentEntryId = null;
      previewLoadError =
        error instanceof Error ? error.message : 'Failed to load preview.';
      previewIsLoading = false;
    });

  return () => {
    cancelled = true;
  };
});

function selectModule(packageName: string) {
  const module = orderedModules.find(
    (candidate) => candidate.packageName === packageName,
  );
  selectedModuleName = packageName;
  selectedEntryId =
    packageName === foundationPackageName
      ? (module?.entries[0]?.qualifiedId ?? null)
      : null;
  selectedMode = module?.entries[0]?.availableModes[0] ?? 'mock';
}

function selectEntry(entry: ResolvedSmrtPlaygroundEntry) {
  selectedModuleName = entry.packageName;
  selectedEntryId = entry.qualifiedId;
  selectedMode = entry.availableModes[0] ?? 'mock';
}
</script>

{#snippet entryButton(entry: ResolvedSmrtPlaygroundEntry)}
  <button
    type="button"
    class:smrt-playground-host__active={entry.qualifiedId === selectedEntry?.qualifiedId}
    aria-pressed={entry.qualifiedId === selectedEntry?.qualifiedId}
    data-playground-entry={entry.qualifiedId}
    onclick={() => selectEntry(entry)}
  >
    {entry.title}
  </button>
{/snippet}

{#snippet playgroundShell()}
  <div
    class="smrt-playground-host__root"
    class:smrt-playground-host__root-embedded={embedded}
    data-hydrated={isHydrated ? 'true' : 'false'} data-smrt-component="PlaygroundHost"
  >
    {#if !embedded}
    <aside class="smrt-playground-host__catalog-nav" data-smrt-part="nav">
      <header class="smrt-playground-host__brand" data-smrt-part="brand">
        <span class="smrt-playground-host__brand-mark" data-smrt-part="icon" aria-hidden="true">S</span>
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </header>

      <label class="smrt-playground-host__search" data-smrt-part="search">
        <span>Find a component</span>
        <input bind:value={searchTerm} placeholder="Search" />
      </label>

      <div class="smrt-playground-host__catalog-scroll" data-smrt-part="body" data-testid="playground-modules">
        {#if filteredModules.length === 0}
          <div class="smrt-playground-host__empty" data-smrt-part="empty">
            <strong>No components found</strong>
            <p>Try another component, package, or tag.</p>
          </div>
        {:else}
          <nav aria-label="Component catalog" data-testid="playground-entries">
            {#if filteredFoundation}
              <section class="smrt-playground-host__foundation-catalog" data-smrt-part="list">
                <button
                  type="button"
                  class="smrt-playground-host__foundation-heading" data-smrt-part="label"
                  data-playground-module={filteredFoundation.packageName}
                  onclick={() => selectModule(filteredFoundation.packageName)}
                >
                  <span>Foundation</span>
                  <small>{filteredFoundation.entries.length}</small>
                </button>

                {#each foundationGroups as [group, entries]}
                  <section class="smrt-playground-host__nav-group" data-smrt-part="group">
                    <h2>{group}</h2>
                    {#each entries as entry (entry.qualifiedId)}
                      {@render entryButton(entry)}
                    {/each}
                  </section>
                {/each}
              </section>
            {/if}

            {#if filteredPackageModules.length > 0}
              <section class="smrt-playground-host__package-groups" data-smrt-part="list">
                <h2>Package components</h2>
                {#each filteredPackageModules as module (module.packageName)}
                  <details open={module.packageName === selectedModule?.packageName}>
                    <summary
                      data-playground-module={module.packageName}
                      onclick={(event) => {
                        event.preventDefault();
                        selectModule(module.packageName);
                      }}
                    >
                      <span>{module.displayName}</span>
                      <small>{module.entries.length}</small>
                    </summary>
                    <div>
                      {#each module.entries as entry (entry.qualifiedId)}
                        {@render entryButton(entry)}
                      {/each}
                    </div>
                  </details>
                {/each}
              </section>
            {/if}
          </nav>
        {/if}
      </div>

      <footer class="smrt-playground-host__theme-controls" data-smrt-part="controls" data-testid="playground-theme-controls">
        <ThemeSwitcher variant="select" label="Theme" />
        <ColorSchemeToggle />
      </footer>
    </aside>
    {/if}

    <svelte:element this={embedded ? 'div' : 'main'} class="smrt-playground-host__workspace" data-smrt-part="workspace">
      {#if selectedModule}
        <header class="smrt-playground-host__workspace-header" data-smrt-part="header">
          <div class="smrt-playground-host__breadcrumbs" data-smrt-part="breadcrumbs">
            <span data-testid="playground-selected-module">{selectedModule.displayName}</span>
            <i aria-hidden="true">/</i>
            <strong>{selectedEntry?.title ?? 'Overview'}</strong>
          </div>

          {#if selectedEntry && selectedEntry.availableModes.length > 1}
            <div class="smrt-playground-host__mode-control" data-smrt-part="control" role="group" aria-label="Preview mode">
              {#each selectedEntry.availableModes as mode}
                <button
                  type="button"
                  class:smrt-playground-host__active={mode === selectedMode}
                  aria-pressed={mode === selectedMode}
                  data-playground-mode={mode}
                  onclick={() => (selectedMode = mode)}
                >
                  {mode}
                </button>
              {/each}
            </div>
          {/if}
        </header>

        {#if selectedEntry}
          <div class="smrt-playground-host__preview-heading" data-smrt-part="label">
            <p data-testid="playground-selected-package">{selectedModule.packageName}</p>
            <h2 data-testid="playground-preview-title">{selectedEntry.title}</h2>
            {#if selectedEntry.description}
              <span>{selectedEntry.description}</span>
            {/if}
            {#if selectedModeConfig?.description}
              <span class="smrt-playground-host__mode-description" data-smrt-part="description">{selectedModeConfig.description}</span>
            {/if}
          </div>

          <section class="smrt-playground-host__preview-panel" data-smrt-part="panel" data-testid="playground-preview-panel">
            <div class="smrt-playground-host__preview-stage" data-smrt-part="stage" data-testid="playground-preview-stage">
              {#if PreviewComponent && previewComponentEntryId === selectedEntry.qualifiedId}
                <PreviewComponent {...selectedProps} />
              {:else if previewIsLoading}
                <div class="smrt-playground-host__preview-state" data-smrt-part="status">
                  <span class="smrt-playground-host__loader" data-smrt-part="progress" aria-hidden="true"></span>
                  <p>Loading {selectedEntry.title}…</p>
                </div>
              {:else}
                <div class="smrt-playground-host__preview-state" data-smrt-part="status">
                  <strong>Preview unavailable</strong>
                  <p>{previewLoadError ?? 'Select a component to begin.'}</p>
                </div>
              {/if}
            </div>
          </section>
        {:else}
          <section class="smrt-playground-host__landing" data-smrt-part="landing" data-testid="playground-package-landing">
            <header>
              <p data-testid="playground-selected-package">{selectedModule.packageName}</p>
              <h2>{selectedModule.displayName}</h2>
              {#if selectedModule.description}
                <span>{selectedModule.description}</span>
              {/if}
              <small>{selectedModule.entries.length} component{selectedModule.entries.length === 1 ? '' : 's'}</small>
            </header>

            <div class="smrt-playground-host__package-index" data-smrt-part="list">
              <h3>Components</h3>
              {#each selectedModule.entries as entry (entry.qualifiedId)}
                <button
                  type="button"
                  data-playground-landing-entry={entry.qualifiedId}
                  onclick={() => selectEntry(entry)}
                >
                  <span class="smrt-playground-host__index-copy" data-smrt-part="body">
                    <strong>{entry.title}</strong>
                    <small>{entry.description ?? entry.id}</small>
                  </span>
                  <span class="smrt-playground-host__index-modes" data-smrt-part="meta">{entry.availableModes.join(' · ')}</span>
                  <span class="smrt-playground-host__index-arrow" data-smrt-part="indicator" aria-hidden="true">→</span>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      {:else}
        <div class="smrt-playground-host__preview-state smrt-playground-host__full-height" data-smrt-part="status">
          <strong>No playground modules discovered</strong>
          <p>The shared host is ready, but nothing exports playground entries yet.</p>
        </div>
      {/if}
    </svelte:element>
  </div>
{/snippet}

{#if inheritedThemeContext}
  {@render playgroundShell()}
{:else}
  <ThemeProvider colorScheme="system" persist={true}>
    {@render playgroundShell()}
  </ThemeProvider>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body) {
    margin: 0;
    min-height: 100vh;
  }
  :global(*) {
    box-sizing: border-box;
  }
  .smrt-playground-host__root {
    display: grid;
    grid-template-columns: 17rem minmax(0, 1fr);
    min-height: 100vh;
  }
  .smrt-playground-host__root-embedded {
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .smrt-playground-host__catalog-nav {
    position: sticky;
    top: 0;
    display: flex;
    height: 100vh;
    flex-direction: column;
    gap: 1.4rem;
    padding: 1.25rem;
    overflow: hidden;
  }
  .smrt-playground-host__brand {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.75rem;
  }
  .smrt-playground-host__brand-mark {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: 0 0 auto;
    place-items: center;
  }
  .smrt-playground-host__brand > div {
    min-width: 0;
  }
  .smrt-playground-host__brand h1 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-playground-host__brand p {
    margin: 0.12rem 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-playground-host__search {
    display: grid;
    gap: 0.4rem;
  }
  .smrt-playground-host__search input {
    width: 100%;
    padding: 0.65rem 0.75rem;
  }
  .smrt-playground-host__catalog-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .smrt-playground-host__catalog-scroll nav,
  .smrt-playground-host__foundation-catalog,
  .smrt-playground-host__nav-group,
  .smrt-playground-host__package-groups {
    display: grid;
  }
  .smrt-playground-host__catalog-scroll nav {
    gap: 1.15rem;
  }
  .smrt-playground-host__foundation-catalog {
    gap: 0.95rem;
  }
  .smrt-playground-host__foundation-heading,
  .smrt-playground-host__nav-group button,
  details button {
    width: 100%;
    cursor: pointer;
  }
  .smrt-playground-host__foundation-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 0.7rem;
  }
  .smrt-playground-host__nav-group {
    gap: 0.12rem;
  }
  .smrt-playground-host__nav-group h2,
  .smrt-playground-host__package-groups > h2 {
    margin: 0 0 0.35rem;
  }
  .smrt-playground-host__nav-group button,
  details button {
    padding: 0.52rem 0.6rem;
  }
  .smrt-playground-host__package-groups {
    gap: 0.15rem;
    padding-top: 0.4rem;
  }
  details summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.58rem 0.3rem;
    cursor: pointer;
    list-style: none;
  }
  details summary::-webkit-details-marker {
    display: none;
  }
  details > div {
    padding-left: 0.45rem;
  }
  .smrt-playground-host__theme-controls {
    display: flex;
    align-items: end;
    gap: 0.5rem;
    padding-top: 0.8rem;
  }
  .smrt-playground-host__theme-controls :global(.smrt-theme-switcher__label) {
    display: none;
  }
  .smrt-playground-host__theme-controls :global(.smrt-theme-switcher__select) {
    min-width: 7rem;
    padding-block: 0.48rem;
  }
  .smrt-playground-host__workspace {
    display: grid;
    min-width: 0;
    align-content: start;
    gap: 1.25rem;
    padding: 1.25rem clamp(1.25rem, 3vw, 3rem) 3rem;
  }
  .smrt-playground-host__root-embedded .smrt-playground-host__workspace {
    padding: 0;
  }
  .smrt-playground-host__workspace-header {
    display: flex;
    min-height: 2.75rem;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .smrt-playground-host__breadcrumbs {
    display: flex;
    min-width: 0;
    gap: 0.55rem;
  }
  .smrt-playground-host__breadcrumbs span,
  .smrt-playground-host__breadcrumbs strong {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-playground-host__mode-control {
    display: flex;
    flex: 0 0 auto;
    gap: 0.25rem;
    padding: 0.2rem;
  }
  .smrt-playground-host__mode-control button {
    padding: 0.4rem 0.7rem;
    cursor: pointer;
  }
  .smrt-playground-host__landing {
    width: min(68rem, 100%);
    padding: clamp(1.5rem, 4vw, 3.5rem) 0 2rem;
  }
  .smrt-playground-host__landing > header {
    position: relative;
    display: grid;
    gap: 0.55rem;
    padding-bottom: clamp(1.75rem, 4vw, 3rem);
  }
  .smrt-playground-host__landing > header p {
    margin: 0;
  }
  .smrt-playground-host__landing > header h2 {
    max-width: 48rem;
    margin: 0;
  }
  .smrt-playground-host__landing > header span {
    max-width: 42rem;
  }
  .smrt-playground-host__landing > header > small {
    position: absolute;
    right: 0;
    bottom: 1rem;
  }
  .smrt-playground-host__package-index {
    padding-top: 2rem;
  }
  .smrt-playground-host__package-index > h3 {
    margin: 0 0 0.65rem;
  }
  .smrt-playground-host__package-index > button {
    display: grid;
    width: 100%;
    grid-template-columns: minmax(0, 1fr) auto 1.5rem;
    align-items: center;
    gap: 1.25rem;
    padding: 1.15rem 0;
    cursor: pointer;
  }
  .smrt-playground-host__index-copy {
    display: grid;
    min-width: 0;
    gap: 0.25rem;
  }
  .smrt-playground-host__preview-heading {
    padding: 1rem 0 0.25rem;
  }
  .smrt-playground-host__preview-heading p {
    margin: 0 0 0.35rem;
  }
  .smrt-playground-host__preview-heading h2 {
    margin: 0;
  }
  .smrt-playground-host__preview-heading span {
    display: block;
    max-width: 48rem;
    margin-top: 0.45rem;
  }
  .smrt-playground-host__preview-panel {
    min-width: 0;
  }
  .smrt-playground-host__preview-stage {
    min-width: 0;
    min-height: 30rem;
    padding: clamp(1rem, 2.2vw, 2rem);
    overflow: auto;
  }
  .smrt-playground-host__preview-state {
    display: grid;
    min-height: 25rem;
    place-content: center;
    justify-items: center;
    padding: 1rem;
  }
  .smrt-playground-host__preview-state p,
  .smrt-playground-host__empty p {
    margin: 0.4rem 0 0;
  }
  .smrt-playground-host__full-height {
    min-height: 60vh;
  }
  .smrt-playground-host__empty {
    padding: 1rem 0.25rem;
  }
  .smrt-playground-host__loader {
    width: 1.25rem;
    height: 1.25rem;
  }
  @media (max-width: 900px) {
    .smrt-playground-host__root {
      grid-template-columns: 1fr;
    }
    .smrt-playground-host__catalog-nav {
      position: static;
      height: auto;
    }
    .smrt-playground-host__catalog-scroll {
      max-height: 18rem;
    }
    .smrt-playground-host__catalog-scroll nav {
      grid-template-columns: 1fr;
    }
  }
  @media (max-width: 600px) {
    .smrt-playground-host__theme-controls :global([data-smrt-component="ThemeSwitcher"]) {
      display: none;
    }
    .smrt-playground-host__workspace-header {
      align-items: flex-start;
    }
    .smrt-playground-host__breadcrumbs {
      display: grid;
      gap: 0.15rem;
    }
    .smrt-playground-host__breadcrumbs i {
      display: none;
    }
    .smrt-playground-host__landing > header > small {
      position: static;
      margin-top: 0.35rem;
    }
    .smrt-playground-host__package-index > button {
      grid-template-columns: minmax(0, 1fr) 1.5rem;
    }
    .smrt-playground-host__index-modes {
      display: none;
    }
  }
}

@layer smrt.theme {
  .smrt-playground-host__root {
    background: var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    font-family: var(--smrt-font-family);
  }
  button,
  input {
    font: inherit;
  }
  button {
    color: inherit;
  }
  .smrt-playground-host__catalog-nav {
    border-right: var(--smrt-hairline);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }
  .smrt-playground-host__brand-mark {
    border-radius: 0.55rem;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-weight: 700;
  }
  .smrt-playground-host__brand h1 {
    font-size: 0.9rem;
    letter-spacing: 0.035em;
  }
  .smrt-playground-host__brand p {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.72rem;
  }
  .smrt-playground-host__search span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.72rem;
  }
  .smrt-playground-host__search input {
    border: var(--smrt-hairline);
    border-radius: 0.55rem;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-playground-host__catalog-scroll {
    scrollbar-width: thin;
  }
  .smrt-playground-host__foundation-heading,
  .smrt-playground-host__nav-group button,
  details button {
    border: 0;
    background: transparent;
    text-align: left;
  }
  .smrt-playground-host__foundation-heading {
    border-bottom: var(--smrt-hairline);
    font-size: 0.82rem;
    font-weight: 650;
  }
  .smrt-playground-host__foundation-heading small,
  details summary small {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.7rem;
    font-weight: 500;
  }
  .smrt-playground-host__nav-group h2,
  .smrt-playground-host__package-groups > h2 {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .smrt-playground-host__nav-group button,
  details button {
    border-radius: 0.45rem;
    font-size: 0.82rem;
  }
  .smrt-playground-host__nav-group button:hover,
  .smrt-playground-host__nav-group button.smrt-playground-host__active,
  details button:hover,
  details button.smrt-playground-host__active {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  details summary {
    font-size: 0.82rem;
  }
  .smrt-playground-host__theme-controls {
    border-top: var(--smrt-hairline);
  }
  .smrt-playground-host__workspace-header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-playground-host__breadcrumbs {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.76rem;
  }
  .smrt-playground-host__breadcrumbs i {
    opacity: 0.5;
  }
  .smrt-playground-host__breadcrumbs strong {
    color: var(--smrt-color-on-surface);
  }
  .smrt-playground-host__mode-control {
    border-radius: 999px;
    background: var(--smrt-color-surface-container);
  }
  .smrt-playground-host__mode-control button {
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.72rem;
    text-transform: capitalize;
  }
  .smrt-playground-host__mode-control button.smrt-playground-host__active {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-playground-host__landing > header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-playground-host__landing > header p {
    color: var(--smrt-color-primary);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: none;
  }
  .smrt-playground-host__landing > header h2 {
    font-size: clamp(2rem, 5vw, 4rem);
    font-weight: 520;
    letter-spacing: -0.045em;
    line-height: 1;
  }
  .smrt-playground-host__landing > header span {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.55;
  }
  .smrt-playground-host__landing > header > small {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.75rem;
  }
  .smrt-playground-host__package-index > h3 {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .smrt-playground-host__package-index > button {
    border: 0;
    border-bottom: var(--smrt-hairline);
    background: transparent;
    text-align: left;
  }
  .smrt-playground-host__index-copy strong {
    font-size: 0.95rem;
    font-weight: 600;
  }
  .smrt-playground-host__index-copy small,
  .smrt-playground-host__index-modes {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.76rem;
    line-height: 1.4;
  }
  .smrt-playground-host__index-modes {
    text-transform: capitalize;
  }
  .smrt-playground-host__index-arrow {
    color: var(--smrt-color-primary);
    transition: transform 140ms ease;
  }
  .smrt-playground-host__package-index > button:hover .smrt-playground-host__index-copy strong,
  .smrt-playground-host__package-index > button:focus-visible .smrt-playground-host__index-copy strong {
    color: var(--smrt-color-primary);
  }
  .smrt-playground-host__package-index > button:hover .smrt-playground-host__index-arrow,
  .smrt-playground-host__package-index > button:focus-visible .smrt-playground-host__index-arrow {
    transform: translateX(0.2rem);
  }
  .smrt-playground-host__preview-heading p {
    color: var(--smrt-color-primary);
    font-size: 0.68rem;
    letter-spacing: 0.08em;
    text-transform: none;
  }
  .smrt-playground-host__preview-heading h2 {
    font-size: clamp(1.45rem, 2.6vw, 2.15rem);
    font-weight: 550;
    letter-spacing: -0.025em;
  }
  .smrt-playground-host__preview-heading span {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.5;
  }
  .smrt-playground-host__preview-heading .smrt-playground-host__mode-description {
    font-size: 0.85rem;
  }
  .smrt-playground-host__preview-stage {
    border: var(--smrt-hairline);
    border-radius: 1rem;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-playground-host__preview-state {
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }
  .smrt-playground-host__preview-state p,
  .smrt-playground-host__empty p {
    line-height: 1.5;
  }
  .smrt-playground-host__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-playground-host__loader {
    border: 2px solid var(--smrt-color-outline-variant);
    border-top-color: var(--smrt-color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 900px) {
    .smrt-playground-host__catalog-nav {
      border-right: 0;
      border-bottom: var(--smrt-hairline);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-playground-host__loader {
      animation: none;
    }
  }
}

</style>
