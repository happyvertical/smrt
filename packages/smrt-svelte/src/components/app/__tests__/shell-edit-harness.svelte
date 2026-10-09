<script lang="ts">
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import type {
  ShellNavGroup,
  ShellPanelDefaults,
} from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import type { DockToggle } from '../dock-toggle.js';
import Probe from './shell-layout-probe.svelte';

let {
  initial,
  layoutEditing = true,
  toggles = [{ tool: 'assistant', label: 'Assistant' }],
  config = { left: { initial: 'expanded' } },
  withActions = false,
  withDock = false,
  edgeToggles = false,
  title = 'SMRT',
  onChange,
  onApi,
}: {
  initial?: ShellLayout | null;
  layoutEditing?: boolean | { slot?: never; floating?: boolean };
  toggles?: DockToggle[];
  config?: ShellPanelDefaults;
  withActions?: boolean;
  withDock?: boolean;
  edgeToggles?:
    | boolean
    | Partial<Record<'top' | 'left' | 'right' | 'bottom', boolean>>;
  title?: string;
  onChange?: (layout: ShellLayout) => void;
  onApi?: (api: ShellLayoutController) => void;
} = $props();

const navGroups: ShellNavGroup[] = [
  { heading: 'Content', items: [{ href: '/posts', label: 'Posts' }] },
  { heading: 'People', items: [{ href: '/users', label: 'Users' }] },
];

let current = $state<ShellLayout | null>(initial ?? null);
function change(next: ShellLayout) {
  current = next;
  onChange?.(next);
}
</script>

{#snippet legacy()}<span data-testid="legacy">Legacy</span>{/snippet}
{#snippet clock()}<span data-testid="clock">12:00</span>{/snippet}
{#snippet actions({ sectionId }: { sectionId: string })}
  <button type="button" aria-label={`Options for ${sectionId}`}>gear</button>
{/snippet}

<AppShell
  {title}
  {edgeToggles}
  {navGroups}
  dockToggles={toggles}
  slots={{ 'footer.center': legacy }}
  slotItems={[{ id: 'host:clock', label: 'Clock', slot: 'header.start', render: clock }]}
  {config}
  {layoutEditing}
  sectionActions={withActions ? actions : undefined}
  layout={current}
  onlayoutchange={change}
>
  {#snippet dock()}
    {#if withDock}
      <ShellDockTool id="assistant" label="Assistant" render={assistantBody} />
    {/if}
  {/snippet}
  {#if onApi}<Probe {onApi} />{/if}
</AppShell>

{#snippet assistantBody()}<p>Assistant body</p>{/snippet}
