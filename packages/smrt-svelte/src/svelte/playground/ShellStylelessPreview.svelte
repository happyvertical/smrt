<script lang="ts">
import unstyledCss from '@happyvertical/smrt-ui/styles/unstyled.css?inline';
import { Card, Disclosure } from '@happyvertical/smrt-ui/ui';
import AdminShell from '../../components/workspace/admin-shell/AdminShell.svelte';
import { createShellState } from '../../components/workspace/admin-shell/state.svelte.js';

// Preview fixture copy lives in script, like the other catalogue previews.
const sample = {
  toggle: 'Apply unstyled.css',
  title: 'Styleless workspace',
  navigation: 'Workspace navigation',
  inspector: 'Inspector tools',
  drawer: 'Application drawer',
  nestedTitle: 'Nested component layout',
  nestedBody:
    "The Card slot keeps the disclosure's spacing and control layout.",
};

let styleless = $state(false);
const shell = createShellState({
  config: { left: { initial: 'expanded' }, right: { initial: 'expanded' } },
});
$effect(() => {
  if (!styleless) return;
  const style = document.createElement('style');
  style.textContent = unstyledCss;
  document.head.append(style);
  return () => style.remove();
});
</script>

<div data-smrt-component="ShellStylelessPreview">
  <label>
    <!-- raw-primitive-allow: native catalogue reset toggle stays visible when SMRT control paint is removed -->
    <input type="checkbox" bind:checked={styleless} /> {sample.toggle}
  </label>
  <AdminShell state={shell} title={sample.title} edgeToggles>
    {#snippet tenantPanel()}<p>{sample.navigation}</p>{/snippet}
    {#snippet focusPanel()}<p>{sample.inspector}</p>{/snippet}
    {#snippet appPanel()}<p>{sample.drawer}</p>{/snippet}
    <Card>
      <Disclosure title={sample.nestedTitle} open>
        <p>{sample.nestedBody}</p>
      </Disclosure>
    </Card>
  </AdminShell>
</div>
