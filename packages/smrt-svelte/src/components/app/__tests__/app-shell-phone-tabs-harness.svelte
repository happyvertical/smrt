<script lang="ts">
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import type { ShellNavItem } from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import type { DockToggle } from '../dock-toggle.js';
import type { PhoneTabBarOptions } from '../phone-tabs.js';

let {
  count = 6,
  toggles = [{ tool: 'assistant', label: 'Assistant' }],
  phoneTabBar = true,
  phoneDock,
  currentHref = '/n1',
  withTool = true,
  config,
}: {
  count?: number;
  toggles?: DockToggle[];
  phoneTabBar?: boolean | PhoneTabBarOptions;
  phoneDock?: 'sheet' | 'drawer';
  currentHref?: string;
  withTool?: boolean;
  config?: Record<string, unknown>;
} = $props();

const nav: ShellNavItem[] = $derived(
  Array.from({ length: count }, (_, index) => ({
    href: `/n${index + 1}`,
    label: `Item ${index + 1}`,
    icon: index === 0 ? 'home' : undefined,
  })),
);
</script>

<AppShell {nav} {currentHref} dockToggles={toggles} {phoneTabBar} {phoneDock} {config}>
  {#snippet dock()}
    {#if withTool}
      <ShellDockTool id="assistant" label="Assistant" render={body} />
    {/if}
  {/snippet}
  <p>Main</p>
</AppShell>

{#snippet body()}<input aria-label="Ask" />{/snippet}
