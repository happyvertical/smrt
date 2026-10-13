<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import AppShell from '../src/components/app/AppShell.svelte';
import AdminShell from '../src/components/workspace/admin-shell/AdminShell.svelte';
import AppScopePanel from '../src/components/workspace/admin-shell/AppScopePanel.svelte';
import ShellDockTool from '../src/components/workspace/admin-shell/ShellDockTool.svelte';
import SystemStatusChips from '../src/components/workspace/admin-shell/SystemStatusChips.svelte';
import { createShellState } from '../src/components/workspace/admin-shell/state.svelte.js';
import TenantNav from '../src/components/workspace/admin-shell/TenantNav.svelte';
import type { PanelState } from '../src/components/workspace/admin-shell/types.js';
import WorkspaceAccountMenu from '../src/components/workspace/admin-shell/WorkspaceAccountMenu.svelte';
import '@happyvertical/smrt-ui/themes/styles/all.css';

const query = new URLSearchParams(window.location.search);
// `?theme=glass|material|studio|smrt` and `?scheme=dark` pick the preset for the
// per-preset screenshots; the default stays smrt light.
const theme = query.get('theme') ?? 'smrt';
const scheme = query.get('scheme') === 'dark' ? 'dark' : 'light';
function panelInitial(name: string): PanelState {
  const value = query.get(name);
  return value === 'expanded' || value === 'hidden' ? value : 'collapsed';
}
const config = {
  left: { initial: panelInitial('left') },
  right: { initial: panelInitial('right') },
  top: { initial: panelInitial('top') },
  bottom: { initial: panelInitial('bottom') },
};
const shell = createShellState({ config, storageKey: 'mobile-shell-fixture' });
if (query.has('tool')) shell.registerFocusTool({ id: 'chat', label: 'Chat' });
let signedOut = $state(false);
const navGroups = [
  { heading: 'Floor', items: [{ href: '#orders', label: 'Orders' }] },
  { heading: 'Office', items: [{ href: '#billing', label: 'Billing' }] },
];
const navItems = [
  { href: '#queue', label: 'Queue' },
  { href: '#reports', label: 'Reports' },
];
// `?tabs`: the AppShell phone tab bar (#3852) instead of the bare AdminShell.
const tabNav = ['Queue', 'Reports', 'Orders', 'Billing', 'Stock', 'Team'].map(
  (label) => ({ href: `#${label.toLowerCase()}`, label }),
);
let tabCurrent = $state(window.location.hash);
const tabBar = query.get('tabs') === 'off' ? false : true;
const chips = Array.from({ length: 8 }, (_, index) => ({
  id: String(index),
  label: `Status ${index + 1}`,
  value: index,
}));
</script>

{#snippet appPanel()}<AppScopePanel appName="Mobile fixture" tenantName="mobile-qa@example.invalid" environment="Tenant 01234567-0123-4567-8901-012345678901" />{/snippet}
{#snippet shellHeader()}<span>Consumer header</span>{/snippet}

{#snippet panel()}<p>Scrollable panel content</p>{/snippet}
{#snippet navigation()}<TenantNav items={navItems} groups={query.has('groups') ? navGroups : []} aria-label="Shop navigation" density="touch" onNavigate={() => shell.setPanelState('left', 'collapsed')} />{/snippet}
{#snippet navigationRail()}<TenantNav items={navItems} groups={query.has('groups') ? navGroups : []} aria-label="Shop navigation" density="touch" collapsed />{/snippet}
{#snippet account()}<WorkspaceAccountMenu userName="Dana" roleLabel="Welder" density="touch" onSignOut={() => { signedOut = true; }} />{/snippet}
{#snippet compactAccount()}<WorkspaceAccountMenu userName="Dana" roleLabel="Welder" density="touch" compact onSignOut={() => { signedOut = true; }} />{/snippet}
{#snippet systemBar()}<SystemStatusChips {chips} />{/snippet}
<svelte:window onhashchange={() => { tabCurrent = window.location.hash; }} />
{#snippet assistantBody()}<input aria-label="Ask" />{/snippet}
<div data-theme={theme} data-color-scheme={scheme}>
{#if query.has('account-menu')}
<AppShell title="Account fixture" nav={tabNav} currentHref="#queue" storageKey="account-menu-fixture"
  user={{ id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' } as never}
  settingsHref="#settings" onSignOut={() => { signedOut = true; }}
  config={{ left: { initial: 'expanded' } }}>
  <p>Main content</p>
  {#if signedOut}<p>Signed out callback</p>{/if}
</AppShell>
{:else if query.has('tabs')}
<AppShell title="Tab fixture" nav={tabNav} currentHref={tabCurrent} phoneTabBar={tabBar}
  dockToggles={[{ tool: 'assistant', label: 'Assistant' }]} storageKey="phone-tabs-fixture">
  {#snippet dock()}<ShellDockTool id="assistant" label="Assistant" render={assistantBody} />{/snippet}
  <p>Main content</p>
</AppShell>
{:else}
<AdminShell edgeToggles state={shell} title="Mobile shell fixture" storageKey="mobile-shell-fixture"
  header={query.has('header') ? shellHeader : undefined}
  homeHref={query.has('brand') ? '/home' : undefined} logoSrc={query.has('brand') ? 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Ccircle cx="16" cy="16" r="15"/%3E%3C/svg%3E' : undefined}
  {appPanel} systemPanel={panel} tenantFooter={query.has('account') ? account : undefined} tenantRailFooter={query.has('railAccount') ? compactAccount : undefined} tenantPanel={navigation} tenantRail={query.has('railFooterOnly') ? undefined : navigationRail} focusPanel={panel} {systemBar}>
  <p>Main content</p>
  {#if signedOut}<p>Signed out callback</p>{/if}
  <Button onclick={() => shell.setPanelState('left', 'hidden')}>Hide navigation</Button>
</AdminShell>
{/if}
</div>

<style>
  :global(body) { margin: 0; font-family: sans-serif; }
</style>
