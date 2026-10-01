<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import AdminShell from '../src/components/workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../src/components/workspace/admin-shell/AppScopePanel.svelte';
import SystemStatusChips from '../src/components/workspace/admin-shell/SystemStatusChips.svelte';
import { createShellState } from '../src/components/workspace/admin-shell/state.svelte.js';
import TenantNav from '../src/components/workspace/admin-shell/TenantNav.svelte';
import type { PanelState } from '../src/components/workspace/admin-shell/types.js';
import '@happyvertical/smrt-ui/themes/styles/smrt.css';

const query = new URLSearchParams(window.location.search);
function state(name: string): PanelState {
  const value = query.get(name);
  return value === 'expanded' || value === 'hidden' ? value : 'collapsed';
}
const config = {
  left: { initial: state('left') },
  right: { initial: state('right') },
  top: { initial: state('top') },
  bottom: { initial: state('bottom') },
};
const shell = createShellState({ config, storageKey: 'mobile-shell-fixture' });
const navItems = [
  { href: '#queue', label: 'Queue' },
  { href: '#reports', label: 'Reports' },
];
const chips = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  label: `Status ${index + 1}`,
  value: index,
}));
</script>

{#snippet appPanel()}<AppScopePanel appName="Mobile fixture" tenantName="mobile-qa@example.invalid" environment="Tenant 01234567-0123-4567-8901-012345678901" />{/snippet}

{#snippet panel()}<p>Scrollable panel content</p>{/snippet}
{#snippet navigation()}<TenantNav items={navItems} density="touch" onNavigate={() => shell.setPanelState('left', 'collapsed')} />{/snippet}
{#snippet navigationRail()}<TenantNav items={navItems} density="touch" collapsed />{/snippet}
{#snippet systemBar()}<SystemStatusChips {chips} />{/snippet}
<div data-theme="smrt" data-color-scheme="light">
<AdminShell state={shell} title="Mobile shell fixture" storageKey="mobile-shell-fixture"
  homeHref={query.has('brand') ? '/home' : undefined} logoSrc={query.has('brand') ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Ccircle cx="16" cy="16" r="15"/%3E%3C/svg%3E' : undefined}
  {appPanel} systemPanel={panel} tenantPanel={navigation} tenantRail={navigationRail} focusPanel={panel} {systemBar}>
  <p>Main content</p>
  <Button onclick={() => shell.setPanelState('left', 'hidden')}>Hide navigation</Button>
</AdminShell>
</div>

<style>
  :global(body) { margin: 0; font-family: sans-serif; }
</style>
