<script lang="ts">
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import ShellLayoutEditor from '../../workspace/admin-shell/ShellLayoutEditor.svelte';
import type {
  ShellNavGroup,
  ShellNavItem,
  ShellPanelDefaults,
} from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import Probe from './shell-layout-probe.svelte';

/**
 * `owned`: the host keeps the layout and feeds it back (controlled).
 * `callback`: only `onlayoutchange` is passed. `default`: neither.
 */
let {
  mode = 'owned',
  initial,
  nav = [],
  navGroups = [],
  config,
  storageKey = 'layout-test',
  editor = true,
  edgeToggles = false,
  onChange,
  onApi,
}: {
  mode?: 'owned' | 'callback' | 'default' | 'frozen';
  initial?: ShellLayout | null;
  nav?: ShellNavItem[];
  navGroups?: ShellNavGroup[];
  config?: ShellPanelDefaults;
  storageKey?: string;
  editor?: boolean;
  edgeToggles?: boolean;
  onChange?: (layout: ShellLayout) => void;
  onApi?: (api: ShellLayoutController) => void;
} = $props();

let current = $state<ShellLayout | null | undefined>(
  mode === 'owned' || mode === 'frozen' ? (initial ?? null) : undefined,
);
function change(next: ShellLayout) {
  if (mode === 'owned') current = next; // 'frozen' hosts ignore every edit
  onChange?.(next);
}
</script>

{#if mode === 'default'}
  <AppShell {nav} {navGroups} {config} {storageKey} {edgeToggles}>
    {#if onApi}<Probe {onApi} />{/if}
    {#if editor}<ShellLayoutEditor />{/if}
  </AppShell>
{:else}
  <AppShell {nav} {navGroups} {config} {storageKey} {edgeToggles} layout={current} onlayoutchange={change}>
    {#if onApi}<Probe {onApi} />{/if}
    {#if editor}<ShellLayoutEditor />{/if}
  </AppShell>
{/if}
