<script lang="ts">
// The shell's Edit layout toggle is the way into the planner: turning edit mode
// on goes to the Planner page (remembering where the visitor was), and Done or
// Escape returns them there. There is no Planner entry in the navigation. A
// section's own page (`/s/<section>/`) is the exception: its entries are edited
// right there (grips, rename, hide on the rows), so edit mode stays on it.
import { useShellLayout } from '@happyvertical/smrt-svelte/workspace';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { appHref } from '../planner/app.svelte.ts';

const layout = useShellLayout();

let returnTo: string | null = null;
let wasEditing = false;

const onSectionPage = () => page.route.id?.startsWith('/s/') === true;
const plannerPath = $derived(new URL(appHref('/'), page.url).pathname);

$effect(() => {
  const editing = layout.editing;
  if (editing === wasEditing) return;
  wasEditing = editing;
  const here = page.url.pathname + page.url.search;
  if (editing) {
    if (page.url.pathname !== plannerPath && !onSectionPage()) {
      returnTo = here;
      void goto(appHref('/'));
    }
  } else if (returnTo) {
    const target = returnTo;
    returnTo = null;
    void goto(target);
  }
});
</script>
