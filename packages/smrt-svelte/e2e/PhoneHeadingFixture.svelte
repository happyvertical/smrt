<script lang="ts">
import { PageHeader, PageLayout } from '@happyvertical/smrt-ui/layout';
import { Button } from '@happyvertical/smrt-ui/ui';
import '@happyvertical/smrt-ui/themes/styles/smrt.css';
import AdminShell from '../src/components/workspace/admin-shell/AdminShell.svelte';
import { phoneTopBarFor } from '../src/components/workspace/admin-shell/mobile-shell.js';
import PhoneTopBar from '../src/components/workspace/admin-shell/PhoneTopBar.svelte';
import TenantNav from '../src/components/workspace/admin-shell/TenantNav.svelte';
import WorkspaceAccountMenu from '../src/components/workspace/admin-shell/WorkspaceAccountMenu.svelte';

const params = new URLSearchParams(window.location.search);
const kind = params.get('kind');
const scheme = params.get('scheme') === 'dark' ? 'dark' : 'light';
let opened = $state(false);
const model = phoneTopBarFor({
  path: kind === 'home' ? '/projects' : '/projects/123',
  homeHref: '/',
  homeTitle: 'Workspace',
  pageTitle: 'Construction project',
  navItems: [{ href: '/projects', label: 'Projects' }],
});
</script>

<div data-theme="smrt" data-color-scheme={scheme}>
  <AdminShell edgeToggles title="Workspace" config={{ right: false, bottom: false }}>
    {#snippet tenantFooter()}
      <WorkspaceAccountMenu
        userName="Dana"
        roleLabel="Welder"
        density="touch"
        onSignOut={() => {}}
      />
      <TenantNav
        items={[
          { href: '#platform-settings', label: 'Platform settings' },
        ]}
        aria-label="Account destinations"
      />
      <span>Authenticated platform administrator</span>
    {/snippet}
    {#snippet phoneTopBar()}
      {#if kind === 'home' || kind === 'detail'}
        <PhoneTopBar {model} homeHref="/" />
      {:else if kind === 'custom'}
        <span data-shell-page-title-replacement>Construction project</span>
      {:else}
        <Button onclick={() => { opened = !opened; }}>Assistant</Button>
      {/if}
    {/snippet}
    <PageLayout><PageHeader title="Construction project" parents={[{ label: 'Projects', href: '/projects' }]} />
      {#if opened}<p>Assistant opened</p>{/if}
      {#if params.has('scroll')}
        {#each Array.from({ length: 80 }, (_, index) => index) as index}
          <p>Project permission group {index + 1}</p>
        {/each}
      {/if}
    </PageLayout>
  </AdminShell>
</div>
