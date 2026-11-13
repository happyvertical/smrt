<script lang="ts">
import EditForm from '../../../screens/EditForm.svelte';
import type { RecipeScreensProps } from '../../../screens/types.js';

let {
  definition,
  policy,
  source,
}: Pick<RecipeScreensProps, 'definition' | 'policy' | 'source'> = $props();
</script>

<section data-testid="installed-recipe-surface" data-smrt-component="FixtureRecipeSurface">
  <p>Installed recipe surface</p>
  <EditForm {definition} {policy} onsubmit={async values => { await source.create?.(values); }} />
</section>
