<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';

interface Props {
  action?: string;
}

let { action = '/party-submit' }: Props = $props();
</script>

{#snippet customActions()}
  <Button type="submit" name="intent" value="custom-save">Store client</Button>
{/snippet}

<CustomerForm
  values={{
    identityKind: 'business',
    name: 'Custom action client',
    contacts: [{ id: 'contact-custom', name: 'Retained custom contact' }],
  }}
  transport={{ action, saveIntent: 'custom-save' }}
  canAddContact={false}
  actions={customActions}
/>
