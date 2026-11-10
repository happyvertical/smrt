<script lang="ts">
import { OwnerSetupForm } from '@happyvertical/smrt-svelte/app';
import { enhance } from '$app/forms';
import type { PageProps } from './$types';

let { data, form }: PageProps = $props();
</script>

<svelte:head><title>Set up your local application</title></svelte:head>

{#if data.desktop}
  <main class="sh-page" data-owner-setup="desktop">
    <div class="sh-card">
      <h1>Quit and reopen the app</h1>
      <p class="sh-muted">
        The desktop app signs you in on its own. If you see this page, quit
        the app and open it again.
      </p>
    </div>
  </main>
{:else}
  <OwnerSetupForm {data} {form} {enhance} title="s-m-r-t app" />
{/if}
