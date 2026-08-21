<script lang="ts">
import { onDestroy, type Snippet, untrack } from 'svelte';
import Input from '../forms/Input.svelte';
import SegmentedControl from '../forms/SegmentedControl.svelte';
import type {
  DataTableController,
  DataTableViewState,
} from './DataTableController.js';
import type { DataSurfaceJsonValue } from './data-surface.js';
import type { CollectionToolbarDataSurfaceOptions } from './types.js';

export interface Props {
  search?: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  view?: 'list' | 'grid' | 'table';
  views?: Array<'list' | 'grid' | 'table'>;
  resultCount?: number;
  selectedCount?: number;
  filters?: Snippet;
  actions?: Snippet;
  bulkActions?: Snippet;
  onsearchchange?: (value: string) => void;
  onviewchange?: (view: 'list' | 'grid' | 'table') => void;
  /** Shares search state with a DataTable controller when supplied. */
  controller?: DataTableController;
  /** Registers this toolbar only when explicitly supplied. */
  dataSurface?: CollectionToolbarDataSurfaceOptions;
  class?: string;
}

let {
  search = $bindable(''),
  searchLabel = 'Search',
  searchPlaceholder = 'Search…',
  view = $bindable('list'),
  views = ['list', 'grid'],
  resultCount,
  selectedCount = 0,
  filters,
  actions,
  bulkActions,
  onsearchchange,
  onviewchange,
  controller,
  dataSurface,
  class: className = '',
}: Props = $props();

let controllerState = $state<DataTableViewState | undefined>(undefined);
let toolbarElement = $state<HTMLDivElement>();
let surfaceHighlighted = $state(false);
let surfaceRegistration:
  | {
      surface: CollectionToolbarDataSurfaceOptions;
      controller: DataTableController | undefined;
      cleanup: () => void;
    }
  | undefined;

$effect(() => {
  if (!controller) {
    controllerState = undefined;
    return;
  }
  controllerState = controller.getState();
  return controller.subscribe((transition) => {
    if (!transition.changed) return;
    controllerState = transition.next.state;
  });
});

const viewOptions = $derived(
  views.map((value) => ({
    value,
    label: value[0].toUpperCase() + value.slice(1),
  })),
);

function changeView(next: string | number) {
  const candidate = String(next);
  if (!views.includes(candidate as typeof view)) return;
  view = candidate as typeof view;
  onviewchange?.(view);
}

function changeSearch(next: string) {
  if (controller) {
    const transition = controller.dispatch({ type: 'setSearch', search: next });
    if (!transition.changed) return;
  } else {
    if (search === next) return;
    search = next;
  }
  onsearchchange?.(next);
}

function payloadObject(
  value: DataSurfaceJsonValue | undefined,
): Record<string, DataSurfaceJsonValue> | undefined {
  return value && !Array.isArray(value) && typeof value === 'object'
    ? value
    : undefined;
}

$effect(() => {
  const surface = dataSurface;
  const surfaceController = controller;
  if (
    surfaceRegistration?.surface === surface &&
    surfaceRegistration?.controller === surfaceController
  ) {
    return;
  }
  surfaceRegistration?.cleanup();
  surfaceRegistration = undefined;
  if (!surface) return;
  const cleanup = untrack(() => {
    let revision = 0;
    let previousStateSignature: string | undefined;
    const readState = () => {
      const state = {
        search: surfaceController?.getState().search ?? search,
        view,
      };
      const signature = JSON.stringify(state);
      if (
        previousStateSignature !== undefined &&
        previousStateSignature !== signature
      ) {
        revision += 1;
      }
      previousStateSignature = signature;
      return state;
    };
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    const unregister = surface.registry.register({
      descriptor: surface.descriptor,
      getSnapshot: () => {
        const state = readState();
        return { revision, state, selection: null };
      },
      execute: async (command) => {
        const payload = payloadObject(command.payload);
        if (
          command.controlId === 'set-search' &&
          typeof payload?.search === 'string'
        ) {
          if (surfaceController) {
            const transition = surfaceController.dispatch({
              type: 'setSearch',
              search: payload.search,
            });
            if (surfaceController.isControlled() && transition.changed) {
              const settled = await surface.applyControlledState?.(
                transition.next.state,
                { type: 'setSearch', search: payload.search },
              );
              if (settled) surfaceController.replaceState(settled);
              if (
                JSON.stringify(surfaceController.getState()) !==
                JSON.stringify(transition.next.state)
              ) {
                return { ok: false };
              }
            }
            onsearchchange?.(payload.search);
            return;
          }
          changeSearch(payload.search);
          return;
        }
        if (
          command.controlId === 'set-view' &&
          typeof payload?.view === 'string'
        ) {
          const prior = view;
          changeView(payload.view);
          return view === prior && payload.view !== prior
            ? { ok: false }
            : undefined;
        }
        switch (command.controlId) {
          case 'focus':
            toolbarElement?.focus();
            return;
          case 'reveal':
            toolbarElement?.scrollIntoView({ block: 'nearest' });
            return;
          case 'highlight':
            surfaceHighlighted = true;
            if (highlightTimer) clearTimeout(highlightTimer);
            highlightTimer = setTimeout(() => {
              surfaceHighlighted = false;
            }, 1_000);
            return;
          case 'refresh':
            if (!surface.onRefresh) return { ok: false };
            await surface.onRefresh();
            return;
          case 'retry':
            if (!surface.onRetry) return { ok: false };
            await surface.onRetry();
            return;
          default:
            return { ok: false };
        }
      },
    });
    return () => {
      if (highlightTimer) clearTimeout(highlightTimer);
      unregister();
    };
  });
  surfaceRegistration = { surface, controller: surfaceController, cleanup };
});

onDestroy(() => surfaceRegistration?.cleanup());
</script>

<div
  bind:this={toolbarElement}
  class="toolbar {className}"
  class:toolbar--highlighted={surfaceHighlighted}
  role="search"
  tabindex="-1"
>
  <div class="search">
    <Input type="search" name="collection-search" aria-label={searchLabel} placeholder={searchPlaceholder} value={controllerState?.search ?? search} oninput={(event) => changeSearch(event.currentTarget.value)} />
  </div>
  {#if filters}<div class="filters">{@render filters()}</div>{/if}
  {#if resultCount !== undefined}<span class="count" aria-live="polite">{resultCount} {resultCount === 1 ? 'result' : 'results'}</span>{/if}
  <span class="spacer"></span>
  {#if selectedCount > 0 && bulkActions}<div class="bulk"><span>{selectedCount} selected</span>{@render bulkActions()}</div>{/if}
  {#if actions}<div class="actions">{@render actions()}</div>{/if}
  {#if viewOptions.length > 1}
    <SegmentedControl label="View" options={viewOptions} value={view} interaction={false} onvaluechange={changeView} />
  {/if}
</div>

<style>
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-2) 0; color: var(--smrt-color-on-surface); }
  .toolbar--highlighted { outline: 2px solid var(--smrt-color-primary, #2563eb); outline-offset: 3px; }
  .search { flex: 1 1 14rem; max-width: 24rem; }
  .filters, .actions, .bulk { display: flex; align-items: center; gap: var(--smrt-spacing-2); }
  .bulk { padding: var(--smrt-spacing-1) var(--smrt-spacing-2); border-radius: var(--smrt-radius-small); background: var(--smrt-color-secondary-container); color: var(--smrt-color-on-secondary-container); }
  .count { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-medium-font); }
  .spacer { flex: 1; }
</style>
