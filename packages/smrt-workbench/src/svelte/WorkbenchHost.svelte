<script lang="ts">
import type {
  SmrtPlaygroundEntry,
  SmrtPlaygroundModule,
} from '@happyvertical/smrt-playground';
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import {
  AdminShell,
  createShellState,
} from '@happyvertical/smrt-svelte/workspace';
import {
  ColorSchemeToggle,
  ThemeProvider,
  ThemeSwitcher,
} from '@happyvertical/smrt-ui/themes';
import type { Component } from 'svelte';
import { onMount } from 'svelte';
import { findWorkbenchRouteByHash, mergeWorkbenchModules } from '../runtime.js';
import type {
  ResolvedWorkbenchRouteEntry,
  SmrtWorkbenchModule,
  SmrtWorkbenchProject,
  WorkbenchApiObjectSummary,
  WorkbenchApiParameterSummary,
  WorkbenchCliCommandSummary,
  WorkbenchDocumentSummary,
  WorkbenchMcpToolSummary,
  WorkbenchPackageSummary,
  WorkbenchRestEndpointSummary,
} from '../types.js';
import { workbenchScriptCommand } from './command.js';
import MarkdownDocument from './MarkdownDocument.svelte';

export interface Props {
  /** Project to display in the workbench. */
  project: SmrtWorkbenchProject;
  /** Workbench modules to display. */
  modules?: SmrtWorkbenchModule[];
  /** Playground modules to display in the playground tab. */
  playgroundModules?: SmrtPlaygroundModule[];
  /** Page title. */
  title?: string;
}

type WorkbenchTab =
  | 'packages'
  | 'playground'
  | 'routes'
  | 'api'
  | 'docs'
  | 'knowledge'
  | 'specialist'
  | 'scripts'
  | 'dependencies'
  | 'migrations'
  | 'examples';

type WorkbenchApiTab = 'objects' | 'rest' | 'mcp' | 'cli';

interface WorkbenchPlaygroundNavEntry extends SmrtPlaygroundEntry {
  qualifiedId: string;
}

let {
  project,
  modules = [],
  playgroundModules = [],
  title = 'Workbench',
}: Props = $props();

const tabs: Array<{ id: WorkbenchTab; label: string }> = [
  { id: 'packages', label: 'Packages' },
  { id: 'playground', label: 'Playground' },
  { id: 'routes', label: 'Routes' },
  { id: 'api', label: 'API' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'specialist', label: 'Specialist' },
  { id: 'scripts', label: 'Tests/Scripts' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'migrations', label: 'Migrations' },
  { id: 'examples', label: 'Examples' },
];

const apiTabs: Array<{ id: WorkbenchApiTab; label: string }> = [
  { id: 'objects', label: 'Objects' },
  { id: 'rest', label: 'REST' },
  { id: 'mcp', label: 'MCP' },
  { id: 'cli', label: 'CLI' },
];

const normalizedModules = $derived(mergeWorkbenchModules(modules));
const scopedPackageName = $derived(project.scope.packageName || null);
const isPackageScoped = $derived(Boolean(scopedPackageName));
const sectionTabs = $derived(tabs.filter((tab) => tab.id !== 'packages'));
const rootNavLabel = $derived(
  project.scope.mode === 'consumer' ? 'Project Packages' : 'Workspace Packages',
);
const visiblePackages = $derived(
  project.packages.filter((packageSummary) => {
    if (scopedPackageName && packageSummary.name !== scopedPackageName) {
      return false;
    }

    if (!searchTerm.trim()) {
      return true;
    }

    const query = searchTerm.toLowerCase();
    return (
      packageSummary.name.toLowerCase().includes(query) ||
      (packageSummary.description || '').toLowerCase().includes(query)
    );
  }),
);

let activeTab = $state<WorkbenchTab>('packages');
let searchTerm = $state('');
let selectedPackageName = $state<string | null>(null);
let expandedPackageName = $state<string | null>(null);
let selectedRouteId = $state<string | null>(null);
let selectedPlaygroundEntryId = $state<string | null>(null);
let selectedDocumentPath = $state<string | null>(null);
let activeApiTab = $state<WorkbenchApiTab>('objects');
let copiedValue = $state<string | null>(null);
let isHydrated = $state(false);

const shellState = createShellState({
  config: {
    top: {
      label: 'Workbench',
      initial: 'collapsed',
      collapsedSize: '3.25rem',
      expandedSize: '13rem',
    },
    left: {
      label: 'Packages',
      initial: 'expanded',
      collapsedSize: '4rem',
      expandedSize: '22rem',
    },
    right: false,
    bottom: {
      label: 'System',
      initial: 'collapsed',
      collapsedSize: '3.25rem',
      expandedSize: '14rem',
    },
  },
  settings: {
    panels: {
      top: 'collapsed',
      left: 'expanded',
      bottom: 'collapsed',
    },
  },
  storageKey: 'smrt-workbench-shell',
});

onMount(() => {
  isHydrated = true;
  const selectRouteFromHash = () => {
    const route = findWorkbenchRouteByHash(
      normalizedModules.flatMap((module) => module.routes),
      window.location.hash,
    );
    if (route) {
      selectRoute(route);
    }
  };

  window.addEventListener('hashchange', selectRouteFromHash);
  selectRouteFromHash();

  return () => {
    window.removeEventListener('hashchange', selectRouteFromHash);
  };
});

const packageStats = $derived(
  new Map(
    project.packages.map((packageSummary) => {
      const workbenchModule = normalizedModules.find(
        (module) => module.packageName === packageSummary.name,
      );
      const playgroundModule = playgroundModules.find(
        (module) => module.packageName === packageSummary.name,
      );

      return [
        packageSummary.name,
        {
          routes: workbenchModule?.routes.length || packageSummary.routeCount,
          routeModules:
            workbenchModule?.routeModules.length ||
            packageSummary.routeModuleCount,
          playground:
            playgroundModule?.entries.length ||
            packageSummary.playgroundEntryCount,
        },
      ] as const;
    }),
  ),
);

$effect(() => {
  const firstPackage = visiblePackages[0] || project.packages[0] || null;
  const selectedStillVisible = visiblePackages.some(
    (packageSummary) => packageSummary.name === selectedPackageName,
  );

  if (!selectedStillVisible) {
    selectedPackageName = firstPackage?.name || null;
    expandedPackageName = firstPackage?.name || null;
    selectedRouteId = null;
    selectedPlaygroundEntryId = null;
  }
});

const selectedBasePackage = $derived(
  project.packages.find(
    (packageSummary) => packageSummary.name === selectedPackageName,
  ) ||
    visiblePackages[0] ||
    project.packages[0] ||
    null,
);

const selectedModule = $derived(
  normalizedModules.find(
    (module) => module.packageName === selectedBasePackage?.name,
  ) || null,
);

const selectedPackage = $derived.by(() => {
  if (!selectedBasePackage) return null;
  if (!selectedModule) return selectedBasePackage;

  return {
    ...selectedBasePackage,
    docs: [...selectedBasePackage.docs, ...(selectedModule.docs || [])],
    examples: [
      ...selectedBasePackage.examples,
      ...(selectedModule.examples || []),
    ],
    recommendedCommands: [
      ...selectedBasePackage.recommendedCommands,
      ...(selectedModule.recommendedCommands || []),
    ],
  };
});

$effect(() => {
  if (isPackageScoped && activeTab === 'packages') {
    activeTab = defaultPackageTab(selectedPackage);
  }
});

const selectedDocument = $derived(
  selectedPackage?.docs.find((doc) => doc.path === selectedDocumentPath) ||
    defaultDocumentFor(selectedPackage) ||
    null,
);

$effect(() => {
  if (!selectedPackage) {
    selectedDocumentPath = null;
    return;
  }

  const selectedStillAvailable = selectedPackage.docs.some(
    (doc) => doc.path === selectedDocumentPath,
  );
  if (!selectedStillAvailable) {
    selectedDocumentPath = defaultDocumentFor(selectedPackage)?.path || null;
  }
});

const selectedRoutes = $derived(selectedModule?.routes || []);
const selectedRoute = $derived(
  selectedRoutes.find((route) => route.qualifiedId === selectedRouteId) ||
    selectedRoutes[0] ||
    null,
);

$effect(() => {
  if (!selectedRoute) {
    selectedRouteId = null;
    return;
  }

  if (selectedRoute.qualifiedId !== selectedRouteId) {
    selectedRouteId = selectedRoute.qualifiedId;
  }
});

const filteredPlaygroundModules = $derived(
  selectedPackage
    ? playgroundModules.filter(
        (module) => module.packageName === selectedPackage.name,
      )
    : playgroundModules,
);

const selectedPlaygroundModule = $derived(
  playgroundModules.find(
    (module) => module.packageName === selectedPackage?.name,
  ) || null,
);

const selectedPlaygroundEntries = $derived(
  (selectedPlaygroundModule?.entries || []).map((entry) => ({
    ...entry,
    qualifiedId: `${selectedPlaygroundModule?.packageName}:${entry.id}`,
  })),
);

const selectedPlaygroundEntry = $derived(
  selectedPlaygroundEntries.find(
    (entry) => entry.qualifiedId === selectedPlaygroundEntryId,
  ) ||
    selectedPlaygroundEntries[0] ||
    null,
);

$effect(() => {
  if (!selectedPlaygroundEntry) {
    selectedPlaygroundEntryId = null;
    return;
  }

  if (selectedPlaygroundEntry.qualifiedId !== selectedPlaygroundEntryId) {
    selectedPlaygroundEntryId = selectedPlaygroundEntry.qualifiedId;
  }
});

let RouteComponent = $state<Component<Record<string, unknown>> | null>(null);
let routeComponentId = $state<string | null>(null);
let routeLoadError = $state<string | null>(null);
let routeIsLoading = $state(false);

function resolveComponent(
  loaded:
    | Component<Record<string, unknown>>
    | { default: Component<Record<string, unknown>> },
): Component<Record<string, unknown>> {
  if (
    loaded &&
    typeof loaded === 'object' &&
    'default' in loaded &&
    loaded.default
  ) {
    return loaded.default;
  }

  return loaded as Component<Record<string, unknown>>;
}

$effect(() => {
  const route = selectedRoute;
  let cancelled = false;
  routeLoadError = null;

  if (!route) {
    RouteComponent = null;
    routeComponentId = null;
    routeIsLoading = false;
    return;
  }

  if (route.component) {
    RouteComponent = route.component as Component<Record<string, unknown>>;
    routeComponentId = route.qualifiedId;
    routeIsLoading = false;
    return;
  }

  if (!route.loadComponent) {
    RouteComponent = null;
    routeComponentId = null;
    routeIsLoading = false;
    routeLoadError = 'Route has no renderable component.';
    return;
  }

  RouteComponent = null;
  routeComponentId = null;
  routeIsLoading = true;

  void route
    .loadComponent()
    .then((loaded) => {
      if (cancelled) {
        return;
      }
      RouteComponent = resolveComponent(loaded);
      routeComponentId = route.qualifiedId;
      routeIsLoading = false;
    })
    .catch((error) => {
      if (cancelled) {
        return;
      }
      RouteComponent = null;
      routeComponentId = null;
      routeLoadError =
        error instanceof Error ? error.message : 'Failed to load route.';
      routeIsLoading = false;
    });

  return () => {
    cancelled = true;
  };
});

const totals = $derived({
  packages: project.packages.length,
  objects: project.packages.reduce(
    (sum, packageSummary) => sum + packageSummary.knowledge.objectCount,
    0,
  ),
  routes: [...packageStats.values()].reduce(
    (sum, stats) => sum + stats.routes,
    0,
  ),
  playground: [...packageStats.values()].reduce(
    (sum, stats) => sum + stats.playground,
    0,
  ),
});

function selectPackage(packageSummary: WorkbenchPackageSummary) {
  const isSelected = selectedPackageName === packageSummary.name;

  if (isSelected) {
    expandedPackageName =
      expandedPackageName === packageSummary.name ? null : packageSummary.name;
    return;
  }

  selectedPackageName = packageSummary.name;
  expandedPackageName = packageSummary.name;
  selectedRouteId = null;
  selectedPlaygroundEntryId = null;
  selectedDocumentPath = null;
  activeApiTab = 'objects';
}

function selectSection(tab: WorkbenchTab) {
  activeTab = tab;
  if (tab === 'api') {
    activeApiTab = 'objects';
  }
}

function selectPlaygroundEntry(entry: WorkbenchPlaygroundNavEntry) {
  selectedPlaygroundEntryId = entry.qualifiedId;
  activeTab = 'playground';
}

function selectRoute(route: ResolvedWorkbenchRouteEntry) {
  selectedPackageName = route.packageName;
  expandedPackageName = route.packageName;
  selectedRouteId = route.qualifiedId;
  activeTab = 'routes';
}

function selectDocument(doc: WorkbenchDocumentSummary) {
  selectedDocumentPath = doc.path;
  activeTab = 'docs';
}

function openPackage(
  packageSummary: WorkbenchPackageSummary,
  tab?: WorkbenchTab,
) {
  selectedPackageName = packageSummary.name;
  expandedPackageName = packageSummary.name;
  selectedRouteId = null;
  selectedPlaygroundEntryId = null;
  selectedDocumentPath = defaultDocumentFor(packageSummary)?.path || null;
  activeApiTab = 'objects';
  activeTab = tab || defaultPackageTab(packageSummary);
}

async function copyValue(value: string) {
  if (!isHydrated || !navigator.clipboard) {
    copiedValue = value;
    return;
  }

  await navigator.clipboard.writeText(value);
  copiedValue = value;
}

function relativePath(path: string | undefined) {
  if (!path) {
    return '';
  }

  const root = `${project.scope.projectRoot}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

function commandFor(
  packageSummary: WorkbenchPackageSummary,
  scriptName: string,
) {
  return workbenchScriptCommand(
    packageSummary,
    scriptName,
    project.scope.packageManager,
  );
}

function recommendedCommandFor(
  packageSummary: WorkbenchPackageSummary,
  command: { id: string; command: string },
) {
  const pnpmFilterPrefix = `pnpm --filter ${packageSummary.name} `;
  return command.command.startsWith(pnpmFilterPrefix)
    ? commandFor(packageSummary, command.command.slice(pnpmFilterPrefix.length))
    : command.command;
}

function dependencyEntries(packageSummary: WorkbenchPackageSummary) {
  return Object.entries({
    ...packageSummary.dependencies,
    ...packageSummary.devDependencies,
    ...packageSummary.peerDependencies,
  }).sort(([left], [right]) => left.localeCompare(right));
}

function apiObjects(
  packageSummary: WorkbenchPackageSummary,
): WorkbenchApiObjectSummary[] {
  if (packageSummary.api.objects?.length > 0) {
    return packageSummary.api.objects;
  }

  return (packageSummary.api.objectNames || []).map((name) => ({
    name,
    qualifiedName: name,
    fields: [],
  }));
}

function apiRestEndpoints(
  packageSummary: WorkbenchPackageSummary,
): WorkbenchRestEndpointSummary[] {
  return packageSummary.api.restEndpoints || [];
}

function apiCliCommands(
  packageSummary: WorkbenchPackageSummary,
): WorkbenchCliCommandSummary[] {
  return packageSummary.api.cliCommands || [];
}

function apiMcpTools(
  packageSummary: WorkbenchPackageSummary,
): WorkbenchMcpToolSummary[] {
  return packageSummary.api.mcpTools || [];
}

function defaultDocumentFor(
  packageSummary: WorkbenchPackageSummary | null,
): WorkbenchDocumentSummary | null {
  return (
    packageSummary?.docs.find((doc) => doc.kind === 'readme') ||
    packageSummary?.docs[0] ||
    null
  );
}

function defaultPackageTab(
  packageSummary: WorkbenchPackageSummary | null,
): WorkbenchTab {
  if (!packageSummary) {
    return 'packages';
  }

  if (defaultDocumentFor(packageSummary)) {
    return 'docs';
  }

  const stats = packageStats.get(packageSummary.name);
  if ((stats?.playground || 0) > 0) {
    return 'playground';
  }
  if ((stats?.routes || 0) > 0) {
    return 'routes';
  }

  return 'api';
}

function specialistUri(packageName: string) {
  return `smrt://workbench/package/${encodeURIComponent(packageName)}/specialist`;
}

function routeProps(route: ResolvedWorkbenchRouteEntry | null) {
  return route?.props || {};
}

function parameterMeta(parameter: WorkbenchApiParameterSummary) {
  const parts: string[] = [parameter.location];
  if (parameter.type) {
    parts.push(parameter.type);
  }
  parts.push(parameter.required ? 'required' : 'optional');
  if (parameter.defaultValue !== undefined) {
    parts.push(`default ${parameter.defaultValue}`);
  }
  return parts.join(' · ');
}

function apiTabCount(
  tab: WorkbenchApiTab,
  objects: WorkbenchApiObjectSummary[],
  restEndpoints: WorkbenchRestEndpointSummary[],
  mcpTools: WorkbenchMcpToolSummary[],
  cliCommands: WorkbenchCliCommandSummary[],
) {
  switch (tab) {
    case 'objects':
      return objects.length;
    case 'rest':
      return restEndpoints.length;
    case 'mcp':
      return mcpTools.length;
    case 'cli':
      return cliCommands.length;
  }
}
</script>

<ThemeProvider colorScheme="dark" persist={true} storageKey="smrt-workbench-theme">
  <div
    class="workbench-shell-root"
    data-hydrated={isHydrated ? 'true' : 'false'}
  >
    <AdminShell
      title={title}
      subtitle={rootNavLabel}
      state={shellState}
    >
      {#snippet topLeftCorner()}
        <div class="workbench-shell-mark" aria-label="SMRT">
          <svg viewBox="0 0 32 32" role="img" aria-label="SMRT">
            <path
              d="M19.7 3.4c1.2 4.1-.3 6.9-2.2 9 2.8-1.1 5-3 6.6-5.5 2.7 4.8 3.1 9.1 1.1 12.9-1.9 3.5-5.3 5.7-9.2 5.7-4 0-7.4-2.2-9.3-5.7-2.1-4-.9-8.5 3.7-13.5-.1 2.8.8 5.1 2.5 6.9 2.5-2.7 4.6-5.8 6.8-9.8Z"
              fill="var(--smrt-color-primary)"
            />
            <path
              d="M15.9 12.1c2.8 3 4.4 5.4 4.4 8.1 0 2.7-1.8 4.9-4.4 4.9s-4.4-2.2-4.4-4.9c0-2.5 1.5-5 4.4-8.1Z"
              fill="var(--smrt-color-tertiary)"
            />
            <path
              d="M8.1 15.7h7.2v4.5H8.1zM16.7 15.7h7.2v4.5h-7.2z"
              fill="none"
              stroke="var(--smrt-color-on-surface)"
              stroke-linejoin="round"
              stroke-width="2"
            />
            <path
              d="M15.2 17.7h1.6M6.6 16.2l1.5.5M23.9 16.7l1.5-.5"
              fill="none"
              stroke="var(--smrt-color-on-surface)"
              stroke-linecap="round"
              stroke-width="2"
            />
          </svg>
        </div>
      {/snippet}

      {#snippet appPanel()}
        <section class="workbench-app-panel" aria-label="Workbench scope">
          <div>
            <p class="eyebrow">{project.scope.projectRoot}</p>
            <h2>{rootNavLabel}</h2>
            <p>
              {project.scope.mode === 'consumer'
                ? 'Installed SMRT packages and local project surfaces discovered for this project.'
                : 'Workspace packages and package-owned surfaces discovered for this repository.'}
            </p>
          </div>
          <dl class="workbench-scope-metrics">
            <div><dt>Packages</dt><dd>{totals.packages}</dd></div>
            <div><dt>Routes</dt><dd>{totals.routes}</dd></div>
            <div><dt>Previews</dt><dd>{totals.playground}</dd></div>
            <div><dt>Objects</dt><dd>{totals.objects}</dd></div>
          </dl>
        </section>
      {/snippet}

      {#snippet tenantPanel()}
        <div class="workbench-nav-shell">
          <header class="workbench-nav-header">
            <div class="workbench-brand">
              <p class="eyebrow brand-badge">
                <svg
                  viewBox="0 0 32 32"
                  role="img"
                  aria-label="SMRT"
                  class="brand-mark"
                >
                  <path
                    d="M19.7 3.4c1.2 4.1-.3 6.9-2.2 9 2.8-1.1 5-3 6.6-5.5 2.7 4.8 3.1 9.1 1.1 12.9-1.9 3.5-5.3 5.7-9.2 5.7-4 0-7.4-2.2-9.3-5.7-2.1-4-.9-8.5 3.7-13.5-.1 2.8.8 5.1 2.5 6.9 2.5-2.7 4.6-5.8 6.8-9.8Z"
                    fill="var(--smrt-color-primary)"
                  />
                  <path
                    d="M15.9 12.1c2.8 3 4.4 5.4 4.4 8.1 0 2.7-1.8 4.9-4.4 4.9s-4.4-2.2-4.4-4.9c0-2.5 1.5-5 4.4-8.1Z"
                    fill="var(--smrt-color-tertiary)"
                  />
                  <path
                    d="M8.1 15.7h7.2v4.5H8.1zM16.7 15.7h7.2v4.5h-7.2z"
                    fill="none"
                    stroke="var(--smrt-color-on-surface)"
                    stroke-linejoin="round"
                    stroke-width="2"
                  />
                  <path
                    d="M15.2 17.7h1.6M6.6 16.2l1.5.5M23.9 16.7l1.5-.5"
                    fill="none"
                    stroke="var(--smrt-color-on-surface)"
                    stroke-linecap="round"
                    stroke-width="2"
                  />
                </svg>
                <span>s-m-r-t</span>
              </p>
              <h1>{title}</h1>
              <p>{rootNavLabel}</p>
            </div>
            <button
              type="button"
              class="workbench-nav-toggle"
              aria-label="Close navigation"
              aria-expanded={shellState.panels.left === 'expanded'}
              title="Close navigation"
              onclick={() => shellState.togglePanel('left')}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect
                  x="4"
                  y="4"
                  width="16"
                  height="16"
                  rx="2"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
                <path
                  d="M9 4v16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.8"
                />
                <path
                  d="m16 9-3 3 3 3"
                  fill="none"
                  stroke="currentColor"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="1.8"
                />
              </svg>
            </button>
          </header>

          <nav class="nav-tree" aria-label="Workbench navigation">
            {#if !isPackageScoped}
              <button
                type="button"
                class:active={activeTab === 'packages'}
                class="root-nav"
                onclick={() => selectSection('packages')}
              >
                <strong>{rootNavLabel}</strong>
                <span>{totals.packages} cataloged · {totals.routes} routes · {totals.playground} previews</span>
              </button>

              <label class="search">
                <span>Filter packages</span>
                <input bind:value={searchTerm} placeholder="Package name or description" />
              </label>
            {/if}

            <div class="package-list" data-testid="workbench-package-list">
              {#if visiblePackages.length === 0}
                <div class="empty-panel">
                  <strong>No packages</strong>
                  <p>No package metadata matched the current filter.</p>
                </div>
              {:else}
                {#each visiblePackages as packageSummary (packageSummary.name)}
                  {@const stats = packageStats.get(packageSummary.name)}
                  {@const packageIsSelected = packageSummary.name === selectedPackage?.name}
                  {@const packageIsExpanded = packageSummary.name === expandedPackageName}
                  <div
                    class:package-node={true}
                    class:package-node--selected={packageIsSelected}
                    class:package-node--expanded={packageIsExpanded}
                  >
                    <button
                      type="button"
                      class:selected={packageIsSelected}
                      aria-expanded={packageIsExpanded}
                      data-workbench-package={packageSummary.name}
                      onclick={() => selectPackage(packageSummary)}
                    >
                      <strong>{packageSummary.name}</strong>
                      <span>{stats?.routes || 0} routes · {stats?.playground || 0} previews</span>
                    </button>

                    {#if packageIsSelected && packageIsExpanded}
                      <div class="section-list" aria-label={`${packageSummary.name} sections`}>
                        {#if packageSummary.docs.length > 0}
                          <div
                            class="document-entry-list"
                            data-testid="workbench-document-entry-list"
                          >
                            {#each packageSummary.docs as doc (doc.path)}
                              <button
                                type="button"
                                class:active={activeTab === 'docs' && doc.path === selectedDocument?.path}
                                aria-pressed={activeTab === 'docs' && doc.path === selectedDocument?.path}
                                data-workbench-document={doc.title}
                                onclick={() => selectDocument(doc)}
                              >
                                <span>{doc.title}</span>
                              </button>
                            {/each}
                          </div>
                        {/if}
                        {#each sectionTabs as tab}
                          <div class="section-node">
                            <button
                              type="button"
                              class:active={activeTab === tab.id}
                              aria-pressed={activeTab === tab.id}
                              onclick={() => selectSection(tab.id)}
                            >
                              {tab.label}
                            </button>
                            {#if tab.id === 'playground' && selectedPlaygroundEntries.length > 0}
                              <div
                                class="playground-entry-list"
                                data-testid="workbench-playground-entry-list"
                              >
                                {#each selectedPlaygroundEntries as entry (entry.qualifiedId)}
                                  <button
                                    type="button"
                                    class:active={activeTab === 'playground' && entry.qualifiedId === selectedPlaygroundEntry?.qualifiedId}
                                    aria-pressed={activeTab === 'playground' && entry.qualifiedId === selectedPlaygroundEntry?.qualifiedId}
                                    data-workbench-playground-entry={entry.qualifiedId}
                                    onclick={() => selectPlaygroundEntry(entry)}
                                  >
                                    <span>{entry.title}</span>
                                  </button>
                                {/each}
                              </div>
                            {/if}
                            {#if tab.id === 'routes' && selectedRoutes.length > 0}
                              <div
                                class="route-entry-list"
                                data-testid="workbench-route-entry-list"
                              >
                                {#each selectedRoutes as route (route.qualifiedId)}
                                  <button
                                    type="button"
                                    class:active={activeTab === 'routes' && route.qualifiedId === selectedRoute?.qualifiedId}
                                    aria-pressed={activeTab === 'routes' && route.qualifiedId === selectedRoute?.qualifiedId}
                                    data-workbench-route-entry={route.qualifiedId}
                                    onclick={() => selectRoute(route)}
                                  >
                                    <span>{route.title}</span>
                                  </button>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </div>
                {/each}
              {/if}
            </div>
          </nav>
        </div>
      {/snippet}

      {#snippet systemPanel()}
        <section class="workbench-system-panel" aria-label="Workbench system">
          <div class="theme-controls">
            <ThemeSwitcher variant="select" label="Theme" />
            <ColorSchemeToggle />
          </div>
          <dl class="workbench-system-summary">
            <div><dt>Scope</dt><dd>{project.scope.mode}</dd></div>
            <div><dt>Packages</dt><dd>{totals.packages}</dd></div>
            <div><dt>Routes</dt><dd>{totals.routes}</dd></div>
            <div><dt>Previews</dt><dd>{totals.playground}</dd></div>
          </dl>
        </section>
      {/snippet}

      <div class="workbench-main">
      <header class="main-header">
        <div>
          <p class="eyebrow" data-testid="workbench-scope">{project.scope.projectRoot}</p>
          <h2>{activeTab === 'packages' && !isPackageScoped ? rootNavLabel : selectedPackage?.name || 'No package selected'}</h2>
          {#if activeTab === 'packages' && !isPackageScoped}
            <p>{project.scope.mode === 'consumer' ? 'Installed SMRT packages and local project surfaces discovered for this project.' : 'Workspace packages and package-owned surfaces discovered for this repository.'}</p>
          {:else if selectedPackage?.description}
            <p>{selectedPackage.description}</p>
          {/if}
        </div>
        <div class="scope-pills">
          <span>{project.scope.mode}</span>
          {#if scopedPackageName}
            <span>focused</span>
          {/if}
        </div>
      </header>

      <section class="tab-panel" data-testid={`workbench-tab-${activeTab}`}>
        {#if activeTab === 'packages'}
          <div class="package-index" data-testid="workbench-package-index">
            {#each visiblePackages as packageSummary (packageSummary.name)}
              {@const stats = packageStats.get(packageSummary.name)}
              <button
                type="button"
                class="package-index-item"
                class:selected={packageSummary.name === selectedPackage?.name}
                onclick={() => openPackage(packageSummary)}
              >
                <span class="package-index-copy">
                  <strong>{packageSummary.name}</strong>
                  <span>{packageSummary.description || 'No package description published.'}</span>
                </span>
                <span class="package-index-meta">
                  <span>{stats?.routes || 0} routes</span>
                  <span>{stats?.playground || 0} previews</span>
                  <span>{packageSummary.version || 'unversioned'}</span>
                </span>
              </button>
            {/each}
          </div>
        {:else if activeTab === 'playground'}
          <div class="playground-embed">
            <PlaygroundHost
              embedded={true}
              hideEntryList={true}
              selectedEntryId={selectedPlaygroundEntryId}
              title={selectedPackage?.name || 'SMRT Playground'}
              subtitle="Package previews inside the workbench"
              modules={filteredPlaygroundModules}
            />
          </div>
        {:else if activeTab === 'routes'}
          {#if selectedRoutes.length === 0}
            <div class="empty-panel">
              <strong>No inline routes</strong>
              <p>This package has no workbench route module.</p>
            </div>
          {:else}
            <div class="route-stage" data-testid="workbench-route-stage">
              {#if selectedRoute && RouteComponent && routeComponentId === selectedRoute.qualifiedId}
                <div class="route-meta">
                  <div>
                    <p class="eyebrow">{selectedRoute.packageName}</p>
                    <h3>{selectedRoute.title}</h3>
                    {#if selectedRoute.description}
                      <p>{selectedRoute.description}</p>
                    {/if}
                  </div>
                  <code>{selectedRoute.defaultPath}</code>
                </div>
                <div class="route-render">
                  <RouteComponent {...routeProps(selectedRoute)} />
                </div>
              {:else if routeIsLoading}
                <div class="empty-panel"><strong>Loading route</strong></div>
              {:else}
                <div class="empty-panel">
                  <strong>Route unavailable</strong>
                  <p>{routeLoadError || 'The selected route could not be rendered.'}</p>
                </div>
              {/if}
            </div>
          {/if}
        {:else if activeTab === 'api' && selectedPackage}
          {@const objects = apiObjects(selectedPackage)}
          {@const restEndpoints = apiRestEndpoints(selectedPackage)}
          {@const cliCommands = apiCliCommands(selectedPackage)}
          {@const mcpTools = apiMcpTools(selectedPackage)}
          <div class="api-layout">
            <div
              class="api-tab-list"
              role="tablist"
              aria-label={`${selectedPackage.name} API surfaces`}
              data-testid="workbench-api-tabs"
            >
              {#each apiTabs as apiTab (apiTab.id)}
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeApiTab === apiTab.id}
                  class:active={activeApiTab === apiTab.id}
                  data-testid={`workbench-api-tab-${apiTab.id}`}
                  onclick={() => (activeApiTab = apiTab.id)}
                >
                  <span>{apiTab.label}</span>
                  <strong>{apiTabCount(apiTab.id, objects, restEndpoints, mcpTools, cliCommands)}</strong>
                </button>
              {/each}
            </div>

            {#if activeApiTab === 'objects'}
              <section class="api-tab-panel" data-testid="workbench-api-objects">
                <h3>Objects <span>{objects.length}</span></h3>
                {#if objects.length === 0}
                  <p class="muted">No object metadata found.</p>
                {:else}
                  <div class="api-object-list">
                    {#each objects as object (object.qualifiedName || object.name)}
                      <article class="api-object-doc">
                        <header>
                          <div>
                            <h4>{object.className || object.name}</h4>
                            {#if object.qualifiedName}
                              <code>{object.qualifiedName}</code>
                            {/if}
                          </div>
                          {#if object.collection}
                            <span>{object.collection}</span>
                          {/if}
                        </header>
                        {#if object.description}
                          <MarkdownDocument content={object.description} />
                        {:else}
                          <p class="muted">No TypeDoc summary found for this object.</p>
                        {/if}
                        {#if object.typedocPath}
                          <p class="muted">TypeDoc: {relativePath(object.typedocPath)}</p>
                        {/if}
                        {#if object.sourcePath}
                          <p class="muted">{relativePath(object.sourcePath)}</p>
                        {/if}
                        {#if object.fields.length > 0}
                          <details>
                            <summary>{object.fields.length} fields</summary>
                            <div class="field-table">
                              {#each object.fields as field (field.name)}
                                <div>
                                  <strong>{field.name}</strong>
                                  <code>{field.type || 'unknown'}</code>
                                  <span>{field.required ? 'required' : 'optional'}</span>
                                  {#if field.related}
                                    <span>{field.related}</span>
                                  {/if}
                                  {#if field.description}
                                    <p>{field.description}</p>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          </details>
                        {/if}
                      </article>
                    {/each}
                  </div>
                {/if}
              </section>
            {:else if activeApiTab === 'rest'}
              <section class="api-tab-panel" data-testid="workbench-api-rest">
                <h3>REST <span>{restEndpoints.length}</span></h3>
                {#if restEndpoints.length === 0}
                  <p class="muted">No REST endpoints exposed.</p>
                {:else}
                  <div class="api-surface-list">
                    {#each restEndpoints as endpoint, index (`rest:${index}:${endpoint.method}:${endpoint.path}:${endpoint.action}`)}
                      {@const copyText = `${endpoint.method} ${endpoint.path}`}
                      <div>
                        <code>{endpoint.method}</code>
                        <span>{endpoint.path}</span>
                        <p>{endpoint.description}</p>
                        {#if endpoint.parameters.length > 0}
                          <div class="api-parameter-list" aria-label={`${endpoint.method} ${endpoint.path} parameters`}>
                            {#each endpoint.parameters as parameter (`${endpoint.method}:${endpoint.path}:${parameter.location}:${parameter.name}`)}
                              <div>
                                <code>{parameter.name}</code>
                                <span>{parameterMeta(parameter)}</span>
                                {#if parameter.description}
                                  <p>{parameter.description}</p>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                        <button type="button" onclick={() => copyValue(copyText)}>
                          {copiedValue === copyText ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </section>
            {:else if activeApiTab === 'mcp'}
              <section class="api-tab-panel" data-testid="workbench-api-mcp">
                <h3>MCP <span>{mcpTools.length}</span></h3>
                {#if mcpTools.length === 0}
                  <p class="muted">No MCP tools exposed.</p>
                {:else}
                  <div class="api-surface-list">
                    {#each mcpTools as tool, index (`mcp:${index}:${tool.toolName}:${tool.action}`)}
                      <div>
                        <code>{tool.toolName}</code>
                        <span>{tool.description}</span>
                        {#if tool.parameters.length > 0}
                          <div class="api-parameter-list" aria-label={`${tool.toolName} parameters`}>
                            {#each tool.parameters as parameter (`${tool.toolName}:${parameter.location}:${parameter.name}`)}
                              <div>
                                <code>{parameter.name}</code>
                                <span>{parameterMeta(parameter)}</span>
                                {#if parameter.description}
                                  <p>{parameter.description}</p>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                        <button type="button" onclick={() => copyValue(tool.toolName)}>
                          {copiedValue === tool.toolName ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </section>
            {:else}
              <section class="api-tab-panel" data-testid="workbench-api-cli">
                <h3>CLI <span>{cliCommands.length}</span></h3>
                {#if cliCommands.length === 0}
                  <p class="muted">No CLI commands exposed.</p>
                {:else}
                  <div class="api-surface-list">
                    {#each cliCommands as command, index (`cli:${index}:${command.command}:${command.action}`)}
                      <div>
                        <code>{command.command}</code>
                        <span>{command.description}</span>
                        {#if command.parameters.length > 0}
                          <div class="api-parameter-list" aria-label={`${command.command} parameters`}>
                            {#each command.parameters as parameter (`${command.command}:${parameter.location}:${parameter.name}`)}
                              <div>
                                <code>{parameter.name}</code>
                                <span>{parameterMeta(parameter)}</span>
                                {#if parameter.description}
                                  <p>{parameter.description}</p>
                                {/if}
                              </div>
                            {/each}
                          </div>
                        {/if}
                        <button type="button" onclick={() => copyValue(command.command)}>
                          {copiedValue === command.command ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}
              </section>
            {/if}
          </div>
        {:else if activeTab === 'docs' && selectedPackage}
          <div class="document-list">
            {#if selectedDocument}
              <article class="document-view" data-testid="workbench-document-view">
                <header>
                  <h3>{selectedDocument.title}</h3>
                  <button type="button" onclick={() => copyValue(selectedDocument.content || '')}>
                    {copiedValue === (selectedDocument.content || '') ? 'Copied' : 'Copy'}
                  </button>
                </header>
                <p class="muted">{relativePath(selectedDocument.path)}</p>
                <MarkdownDocument content={selectedDocument.content || ''} />
                {#if selectedDocument.truncated}
                  <p class="muted">Document truncated for workbench display.</p>
                {/if}
              </article>
            {:else}
              <div class="empty-panel">
                <strong>No documents</strong>
                <p>This package has no README, AGENTS, CHANGELOG, or generated docs entry.</p>
              </div>
            {/if}
          </div>
        {:else if activeTab === 'knowledge' && selectedPackage}
          <div class="surface-grid">
            <section>
              <h3>Knowledge Summary</h3>
              <dl class="definition-list">
                <div><dt>Objects</dt><dd>{selectedPackage.knowledge.objectCount}</dd></div>
                <div><dt>Relationships</dt><dd>{selectedPackage.knowledge.relationshipCount}</dd></div>
                <div><dt>Prompts</dt><dd>{selectedPackage.knowledge.promptCount}</dd></div>
                <div><dt>MCP tools</dt><dd>{selectedPackage.knowledge.mcpToolCount}</dd></div>
                <div><dt>Surfaces</dt><dd>{selectedPackage.knowledge.surfaceCount}</dd></div>
              </dl>
            </section>
            <section>
              <h3>Sources</h3>
              <ul class="file-list">
                <li>{selectedPackage.knowledge.knowledgePath ? relativePath(selectedPackage.knowledge.knowledgePath) : 'smrt-knowledge.json missing'}</li>
                <li>{selectedPackage.knowledge.manifestPath ? relativePath(selectedPackage.knowledge.manifestPath) : 'manifest missing'}</li>
              </ul>
            </section>
          </div>
        {:else if activeTab === 'specialist' && selectedPackage}
          <div class="specialist-panel">
            <section>
              <h3>Package Specialist Context</h3>
              <p class="muted">{specialistUri(selectedPackage.name)}</p>
              <button type="button" onclick={() => copyValue(specialistUri(selectedPackage.name))}>
                {copiedValue === specialistUri(selectedPackage.name) ? 'Copied' : 'Copy resource URI'}
              </button>
            </section>
            <section>
              <h3>Source List</h3>
              <ul class="file-list">
                {#each selectedPackage.docs as doc}
                  <li>{relativePath(doc.path)}</li>
                {/each}
                {#if selectedPackage.knowledge.knowledgePath}
                  <li>{relativePath(selectedPackage.knowledge.knowledgePath)}</li>
                {/if}
                {#if selectedPackage.knowledge.manifestPath}
                  <li>{relativePath(selectedPackage.knowledge.manifestPath)}</li>
                {/if}
              </ul>
            </section>
          </div>
        {:else if activeTab === 'scripts' && selectedPackage}
          <div class="script-list">
            {#each Object.entries(selectedPackage.scripts) as [scriptName, script]}
              {@const command = commandFor(selectedPackage, scriptName)}
              <div>
                <div>
                  <strong>{scriptName}</strong>
                  <code>{script}</code>
                </div>
                <button type="button" onclick={() => copyValue(command)}>
                  {copiedValue === command ? 'Copied' : 'Copy'}
                </button>
              </div>
            {/each}
            {#each selectedPackage.recommendedCommands as recommendation (`${recommendation.id}:${recommendation.command}`)}
              {@const command = recommendedCommandFor(selectedPackage, recommendation)}
              <div>
                <div>
                  <strong>{recommendation.label}</strong>
                  {#if recommendation.description}<span>{recommendation.description}</span>{/if}
                  <code>{command}</code>
                </div>
                <button type="button" onclick={() => copyValue(command)}>
                  {copiedValue === command ? 'Copied' : 'Copy'}
                </button>
              </div>
            {/each}
          </div>
        {:else if activeTab === 'dependencies' && selectedPackage}
          <div class="surface-grid">
            <section>
              <h3>SMRT Dependencies</h3>
              <div class="chip-list">
                {#each selectedPackage.smrtDependencies as dependency}
                  <code>{dependency}</code>
                {/each}
              </div>
            </section>
            <section>
              <h3>SDK Dependencies</h3>
              <div class="chip-list">
                {#each selectedPackage.sdkDependencies as dependency}
                  <code>{dependency}</code>
                {/each}
              </div>
            </section>
            <section>
              <h3>All Dependencies</h3>
              <div class="dependency-list">
                {#each dependencyEntries(selectedPackage) as [dependency, version]}
                  <div><span>{dependency}</span><code>{version}</code></div>
                {/each}
              </div>
            </section>
          </div>
        {:else if activeTab === 'migrations' && selectedPackage}
          <div class="document-list">
            <article>
              <h3>Migrations</h3>
              {#if selectedPackage.migrations.length === 0}
                <p class="muted">No migration files found.</p>
              {:else}
                <ul class="file-list">
                  {#each selectedPackage.migrations as file}
                    <li>{relativePath(file)}</li>
                  {/each}
                </ul>
              {/if}
            </article>
          </div>
        {:else if activeTab === 'examples' && selectedPackage}
          <div class="document-list">
            {#if selectedPackage.examples.length === 0}
              <div class="empty-panel">
                <strong>No examples found</strong>
                <p>No examples or README code blocks were discovered.</p>
              </div>
            {:else}
              {#each selectedPackage.examples as example}
                <article>
                  <header>
                    <h3>{example.title}</h3>
                    {#if example.code}
                      <button type="button" onclick={() => copyValue(example.code || '')}>
                        {copiedValue === (example.code || '') ? 'Copied' : 'Copy'}
                      </button>
                    {/if}
                  </header>
                  {#if example.path}
                    <p class="muted">{relativePath(example.path)}</p>
                  {/if}
                  {#if example.code}
                    <pre>{example.code}</pre>
                  {/if}
                </article>
              {/each}
            {/if}
          </div>
        {/if}
      </section>
      </div>
    </AdminShell>
  </div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    min-height: 100svh;
  }

  .workbench-shell-root {
    min-height: 100svh;
  }

  .workbench-shell-mark {
    display: grid;
    place-items: center;
    min-inline-size: 0;
  }

  .workbench-shell-mark svg {
    inline-size: 1.35rem;
    block-size: 1.35rem;
  }

  .workbench-app-panel,
  .workbench-nav-shell,
  .workbench-system-panel,
  .search,
  .package-list,
  .section-list,
  .workbench-main,
  .surface-grid,
  .document-list,
  .specialist-panel {
    display: grid;
    gap: 0.75rem;
  }

  .workbench-brand h1,
  .workbench-app-panel h2,
  .main-header h2,
  h3 {
    margin: 0;
  }

  .workbench-brand p,
  .workbench-app-panel p,
  .main-header p,
  .empty-panel p,
  .muted {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.5;
  }

  .workbench-nav-header {
    display: flex;
    gap: 0.75rem;
    align-items: start;
    justify-content: space-between;
  }

  .workbench-brand {
    display: grid;
    gap: 0.15rem;
    min-width: 0;
  }

  .brand-badge {
    display: inline-flex;
    gap: 0.45rem;
    align-items: center;
  }

  .brand-mark {
    width: 1rem;
    height: 1rem;
    display: block;
  }

  .workbench-nav-toggle {
    display: inline-grid;
    flex: 0 0 auto;
    width: 2rem;
    height: 2rem;
    place-items: center;
    cursor: pointer;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .workbench-nav-toggle:hover {
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 12%, transparent);
  }

  .workbench-nav-toggle svg {
    width: 1rem;
    height: 1rem;
  }

  .eyebrow {
    margin: 0 0 0.35rem;
    font-size: 0.72rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--smrt-color-primary);
  }

  .theme-controls {
    display: flex;
    align-items: flex-end;
    gap: 0.55rem;
  }

  .theme-controls :global(.smrt-theme-switcher) {
    flex: 1;
  }

  .workbench-scope-metrics,
  .workbench-system-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0;
  }

  .workbench-system-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .workbench-scope-metrics div,
  .workbench-system-summary div {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
    padding: 0.75rem;
  }

  .workbench-scope-metrics dt,
  .workbench-system-summary dt {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.78rem;
  }

  .workbench-scope-metrics dd,
  .workbench-system-summary dd {
    margin: 0.2rem 0 0;
    font-weight: 700;
  }

  .nav-tree {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    min-height: 0;
    overflow: auto;
    padding-right: 0.15rem;
  }

  .search span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.82rem;
  }

  .search input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-high);
    color: inherit;
    padding: 0.72rem 0.8rem;
  }

  button {
    font: inherit;
  }

  .root-nav,
  .package-node > button {
    display: grid;
    gap: 0.2rem;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border-radius: 6px;
    border: 1px solid transparent;
    padding: 0.75rem 0.85rem;
  }

  .root-nav,
  .package-node > button {
    background: var(--smrt-color-surface-container-low);
    color: inherit;
  }

  .root-nav.active,
  .root-nav:hover,
  .package-node > button.selected,
  .package-node > button:hover {
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 16%, transparent);
  }

  .root-nav span,
  .package-node > button span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.82rem;
  }

  .package-node {
    display: grid;
    gap: 0.45rem;
  }

  .section-list {
    padding-left: 0.65rem;
    border-left: 1px solid var(--smrt-color-outline-variant);
    margin-left: 0.65rem;
  }

  .section-node,
  .playground-entry-list,
  .route-entry-list,
  .document-entry-list,
  .api-object-list,
  .api-surface-list {
    display: grid;
    gap: 0.25rem;
  }

  .section-list button {
    cursor: pointer;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    padding: 0.42rem 0.55rem;
    text-align: left;
  }

  .playground-entry-list,
  .route-entry-list {
    padding-left: 0.65rem;
  }

  .playground-entry-list button,
  .route-entry-list button,
  .document-entry-list button {
    padding: 0.32rem 0.5rem;
    font-size: 0.82rem;
  }

  .playground-entry-list button span,
  .route-entry-list button span,
  .document-entry-list button span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .section-list button.active,
  .section-list button:hover {
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container-high);
  }

  .workbench-main {
    align-content: start;
    padding: 1rem;
    gap: 1rem;
  }

  .main-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: 1rem;
  }

  .scope-pills,
  .chip-list {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .scope-pills span,
  .chip-list code {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    padding: 0.24rem 0.55rem;
    background: var(--smrt-color-surface-container-low);
    font-size: 0.78rem;
  }

  .tab-panel {
    min-height: 38rem;
  }

  .surface-grid section,
  .document-list article,
  .specialist-panel section,
  .empty-panel,
  .route-stage,
  .script-list > div {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    padding: 1rem;
  }

  .surface-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .surface-grid ul,
  .file-list {
    margin: 0.75rem 0 0;
    padding-left: 1.1rem;
    line-height: 1.65;
  }

  .package-index,
  .script-list,
  .dependency-list {
    display: grid;
    gap: 0.55rem;
  }

  .package-index {
    gap: 0.7rem;
  }

  .package-index-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 1rem;
    width: 100%;
    cursor: pointer;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    color: inherit;
    padding: 0.9rem 1rem;
    text-align: left;
  }

  .package-index-item.selected,
  .package-index-item:hover {
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, var(--smrt-color-surface));
  }

  .package-index-copy {
    display: grid;
    gap: 0.28rem;
    min-width: 0;
  }

  .package-index-copy > span {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .package-index-meta {
    display: flex;
    gap: 0.45rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .package-index-meta span {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    padding: 0.22rem 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.76rem;
  }

  .playground-embed {
    min-width: 0;
  }

  .route-stage {
    min-width: 0;
    overflow: hidden;
  }

  .route-meta {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
    margin-bottom: 1rem;
  }

  .route-render {
    overflow: auto;
    max-height: 72vh;
  }

  .api-layout {
    display: grid;
    gap: 1rem;
    align-items: start;
  }

  .api-tab-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: 0.75rem;
  }

  .api-tab-list button {
    display: inline-flex;
    cursor: pointer;
    align-items: center;
    gap: 0.45rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 999px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    padding: 0.42rem 0.75rem;
  }

  .api-tab-list button.active,
  .api-tab-list button:hover {
    border-color: var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 12%, var(--smrt-color-surface));
    color: var(--smrt-color-on-surface);
  }

  .api-tab-list strong {
    color: inherit;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .api-tab-panel {
    display: grid;
    gap: 1rem;
  }

  .api-layout section {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface);
    padding: 1rem;
    scroll-margin-top: 1rem;
  }

  .api-layout h3 span {
    margin-left: 0.35rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.78rem;
    font-weight: 500;
  }

  .api-object-list {
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .api-surface-list {
    gap: 0.55rem;
    margin-top: 0.75rem;
  }

  .api-object-doc {
    display: grid;
    gap: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    background: var(--smrt-color-surface-container-low);
    padding: 0.85rem;
  }

  .api-object-doc header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }

  .api-object-doc h4 {
    margin: 0 0 0.35rem;
  }

  .api-object-doc code,
  .field-table code {
    word-break: break-word;
  }

  .api-object-doc header > span,
  .field-table span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.78rem;
  }

  .api-object-doc details {
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 0.65rem;
  }

  .api-object-doc summary {
    cursor: pointer;
    color: var(--smrt-color-on-surface);
  }

  .api-surface-list > div {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.45rem 0.75rem;
    align-items: start;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding: 0.55rem 0;
  }

  .api-surface-list code {
    word-break: break-word;
  }

  .api-surface-list span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .api-surface-list > div > p {
    grid-column: 2 / 3;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.4;
  }

  .api-surface-list button {
    grid-column: 3 / 4;
    grid-row: 1 / 2;
    justify-self: end;
    cursor: pointer;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    padding: 0.32rem 0.55rem;
  }

  .api-parameter-list {
    grid-column: 1 / -1;
    display: grid;
    gap: 0.35rem;
    border-left: 2px solid var(--smrt-color-outline-variant);
    margin-top: 0.15rem;
    padding: 0.45rem 0 0.2rem 0.65rem;
  }

  .api-parameter-list > div {
    display: grid;
    grid-template-columns: minmax(7rem, auto) minmax(0, 1fr);
    gap: 0.2rem 0.65rem;
    align-items: baseline;
  }

  .api-parameter-list span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.78rem;
  }

  .api-parameter-list p {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.78rem;
    line-height: 1.35;
  }

  .field-table {
    display: grid;
    gap: 0.5rem;
    margin-top: 0.65rem;
  }

  .field-table > div {
    display: grid;
    grid-template-columns: minmax(8rem, 1fr) minmax(6rem, auto) auto auto;
    gap: 0.45rem 0.7rem;
    align-items: start;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: 0.5rem;
  }

  .field-table p {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.45;
  }

  .document-list pre {
    max-height: 30rem;
    overflow: auto;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 6px;
    padding: 0.75rem;
    background: var(--smrt-color-surface-container-lowest);
    color: var(--smrt-color-on-surface);
    white-space: pre-wrap;
  }

  .document-list header,
  .script-list > div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }

  .document-list button,
  .script-list button,
  .specialist-panel button {
    cursor: pointer;
    border: 1px solid var(--smrt-color-primary);
    border-radius: 6px;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    padding: 0.45rem 0.7rem;
  }

  .script-list code,
  .dependency-list code,
  .route-meta code {
    word-break: break-word;
  }

  .dependency-list > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding: 0.45rem 0;
  }

  .definition-list {
    display: grid;
    gap: 0.45rem;
    margin: 0.75rem 0 0;
  }

  .definition-list div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    padding-bottom: 0.35rem;
  }

  .definition-list dt {
    color: var(--smrt-color-on-surface-variant);
  }

  .definition-list dd {
    margin: 0;
    font-weight: 700;
  }

  @media (max-width: 960px) {
    .workbench-scope-metrics,
    .workbench-system-summary,
    .surface-grid,
    .api-layout {
      grid-template-columns: 1fr;
    }

    .package-index-item {
      grid-template-columns: 1fr;
    }

    .package-index-meta {
      justify-content: flex-start;
    }

    .field-table > div {
      grid-template-columns: 1fr;
    }

    .api-surface-list > div {
      grid-template-columns: 1fr;
    }

    .api-surface-list > div > p {
      grid-column: auto;
    }

    .api-surface-list button {
      grid-column: auto;
      grid-row: auto;
      justify-self: start;
    }

    .api-parameter-list,
    .api-parameter-list > div {
      grid-template-columns: 1fr;
    }
  }
</style>
