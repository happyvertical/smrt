<script lang="ts">
import AdvancedStyles from '$lib/components/AdvancedStyles.svelte';
import { appQuery, getBasePath } from '$lib/planner/app.svelte.ts';
import { withTab } from '$lib/planner/query.ts';

// Back to the Theme tab under any deployment sub-path, keeping app state.
const backHref = `${getBasePath()}/${withTab(appQuery(), 'theme')}`;
</script>

<svelte:head><title>Advanced Styles · smrt planner</title></svelte:head>
<main><AdvancedStyles {backHref} /></main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  main { width: min(100%, 72rem); margin-inline: auto; padding: var(--smrt-spacing-6); }
}
</style>
