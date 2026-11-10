<script lang="ts">
import { onMount } from 'svelte';
import { goto } from '$app/navigation';
import { base } from '$app/paths';

// The Blueprint page became the Planner's Export tab. The site is static, so
// the redirect is client-side; a link's other query parameters are kept.
onMount(() => {
  const params = new URLSearchParams(location.search);
  params.set('tab', 'export');
  void goto(`${base}/?${params.toString().replace(/%2C/gi, ',')}`, {
    replaceState: true,
  });
});
</script>

<svelte:head>
  <title>Moved · smrt planner</title>
</svelte:head>

<main>
  <p>The Cookbook is in the Planner's <a href={`${base}/?tab=export`}>Export tab</a>.</p>
</main>
