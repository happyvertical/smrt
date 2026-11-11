<script lang="ts">
import { CookbookApp } from '@happyvertical/smrt-svelte/cookbook';
import { createCookbookAssistant } from '@happyvertical/smrt-template-sveltekit/host/client';
import { signOut } from '@happyvertical/smrt-template-sveltekit/host/sveltekit-client';
import type { Cookbook } from '@happyvertical/smrt-types';
import { invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import type { LayoutProps } from './$types';

let { data, children }: LayoutProps = $props();
const assistant = createCookbookAssistant({ onchange: invalidateAll });
async function saveEdits(next: Cookbook) {
  const response = await fetch('/api/cookbook/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(next),
  });
  if (!response.ok) throw new Error('Could not save your layout preferences.');
}
</script>

{#if data.cookbookApp}
  <CookbookApp
    cookbook={data.cookbookApp.cookbook}
    catalog={data.cookbookApp.catalog}
    href={(path: string) => path.replace(/(.)\/$/, '$1')}
    title={data.cookbookApp.cookbook.name ?? 'My app'}
    navMode="sections-with-items"
    currentHref={page.url.pathname}
    settingsHref="/settings"
    user={data.session.user}
    onSignOut={signOut}
    accountMenu={{ theme: true }}
    edgeToggles={{ left: true }}
    config={{ left: { initial: 'expanded' } }}
    assistant={data.session.authenticated ? assistant : undefined}
    embed={data.embed}
    phoneTabBar
    runtimeDiagnostics={data.session.authenticated}
    layoutEditing={data.session.authenticated}
    oncookbookchange={data.session.authenticated ? saveEdits : undefined}
    chrome={!page.route.id?.startsWith('/setup')}
  >
    {@render children()}
  </CookbookApp>
{/if}
