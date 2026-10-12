<script lang="ts">
  import { page } from '$app/state';
  import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
  import { AppShell } from '@happyvertical/smrt-svelte/app';
  import type { ShellNavItem } from '@happyvertical/smrt-svelte/workspace';
  import { signOut } from '$lib/sign-out';
  import type { LayoutProps } from './$types';

  let { data, children }: LayoutProps = $props();

  // Add application routes here. Generated REST routes live under /api and do
  // not automatically imply a human-facing page.
  const nav: ShellNavItem[] = [
    { href: '/', label: 'Notes', icon: 'book', description: 'Your workspace notes' },
    { href: '/settings', label: 'Settings', icon: 'settings', description: 'Workspace layout and shortcuts' },
  ];

  // Generated read-only WebMCP tools, only in browsers that expose WebMCP.
  const webmcp = $derived(
    typeof document !== 'undefined' && 'modelContext' in document
      ? { definitions: webMcpToolDefinitions, basePath: '/api', effects: ['read'] as const }
      : false,
  );
</script>

<AppShell
  title="s-m-r-t app"
  {webmcp}
  {nav}
  currentHref={page.url.pathname}
  runtimeDiagnostics={data.session.authenticated}
  settingsHref="/settings"
  user={data.session.user}
  onSignOut={signOut}
  phoneTabBar
  chrome={!page.route.id?.startsWith('/setup')}
>
  {@render children()}
</AppShell>
