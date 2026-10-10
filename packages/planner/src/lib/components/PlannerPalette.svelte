<script lang="ts">
// Find anything in the planner: the pages of the menu as it is laid out (a
// section the visitor hid stays hidden), the planner's own tabs, and every
// feature, which the palette adds to the cookbook. Mounted once, in the
// header, by the layout; Mod+K opens it.
import {
  CommandPalette,
  createNavigationProvider,
  type PaletteProvider,
} from '@happyvertical/smrt-svelte/command-palette';
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { goto } from '$app/navigation';
import { plannerProviders } from '$lib/features/palette.ts';
import { appHref } from '$lib/planner/app.svelte.ts';
import { recipes } from '$lib/recipes/index.ts';
import { recipeState } from '$lib/recipes/state.svelte.ts';

const layout = useShellLayout();

const providers: readonly PaletteProvider[] = [
  createNavigationProvider({
    nav: () => layout.applied.nav,
    groups: () => layout.applied.groups,
  }),
  ...plannerProviders({
    recipes,
    isOn: (id) => recipeState.has(id),
    add: (id) => recipeState.add(id),
    href: (tab) => appHref(`/?tab=${tab}`),
  }),
];
</script>

<CommandPalette
  {providers}
  navigate={(href) => goto(href)}
  label="Search"
/>
