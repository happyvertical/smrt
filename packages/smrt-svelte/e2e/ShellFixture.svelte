<script lang="ts">
import AdminShell from '../src/components/workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../src/components/workspace/admin-shell/AppScopePanel.svelte';
import SystemStatusChips from '../src/components/workspace/admin-shell/SystemStatusChips.svelte';
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
const chips = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  label: `Status ${index + 1}`,
  value: index,
}));
</script>

{#snippet appPanel()}<AppScopePanel appName="Mobile fixture" tenantName="mobile-qa@example.invalid" environment="Tenant 01234567-0123-4567-8901-012345678901" />{/snippet}

{#snippet panel()}<p>Scrollable panel content</p>{/snippet}
{#snippet systemBar()}<SystemStatusChips {chips} />{/snippet}
<div data-theme="smrt" data-color-scheme="light">
<AdminShell {config} title="Mobile shell fixture" storageKey="mobile-shell-fixture"
  homeHref={query.has('brand') ? '/home' : undefined} logoSrc={query.has('brand') ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Ccircle cx="16" cy="16" r="15"/%3E%3C/svg%3E' : undefined}
  {appPanel} systemPanel={panel} tenantPanel={panel} focusPanel={panel} {systemBar}>
  <p>Main content</p>
</AdminShell>
</div>

<style>
  :global(body) { margin: 0; font-family: sans-serif; }
</style>
