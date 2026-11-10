<script lang="ts">
import ThemeProvider from '../../../themes/ThemeProvider.svelte';
import Input from '../../forms/Input.svelte';
import Button from '../../ui/Button.svelte';
import CollectionToolbar from '../CollectionToolbar.svelte';

let {
  density = 'comfortable',
}: { density?: 'comfortable' | 'touch' | 'inherit' } = $props();
</script>

<ThemeProvider density="touch" overrides={{ '--smrt-touch-target-min': '56px', '--smrt-control-height': '40px' }} persist={false} inlineVariables>
  <CollectionToolbar density={density === 'inherit' ? undefined : density} views={['list']}>
    {#snippet filters()}
      <Input aria-label="Inherited toolbar filter" />
    {/snippet}
    {#snippet actions()}
      <Button>Inherited toolbar action</Button>
    {/snippet}
  </CollectionToolbar>
</ThemeProvider>
