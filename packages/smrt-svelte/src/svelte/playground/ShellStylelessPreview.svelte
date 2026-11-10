<script lang="ts">
import unstyledCss from '@happyvertical/smrt-ui/styles/unstyled.css?inline';
import { Card, Disclosure } from '@happyvertical/smrt-ui/ui';
import AdminShell from '../../components/workspace/admin-shell/AdminShell.svelte';
import { createShellState } from '../../components/workspace/admin-shell/state.svelte.js';

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
  <label><input type="checkbox" bind:checked={styleless} /> Apply unstyled.css</label>
  <AdminShell state={shell} title="Styleless workspace" edgeToggles>
    {#snippet tenantPanel()}<p>Workspace navigation</p>{/snippet}
    {#snippet focusPanel()}<p>Inspector tools</p>{/snippet}
    {#snippet appPanel()}<p>Application drawer</p>{/snippet}
    <Card>
      <Disclosure title="Nested component layout" open>
        <p>The Card slot keeps the disclosure's spacing and control layout.</p>
      </Disclosure>
    </Card>
  </AdminShell>
</div>
