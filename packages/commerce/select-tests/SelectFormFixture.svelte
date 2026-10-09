<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import { untrack } from 'svelte';
import CustomerSelect from '../src/svelte/components/CustomerSelect.svelte';
import type { Props } from '../src/svelte/components/CustomerSelect.svelte';

/** A native form around the customer selector, optionally in another locale. */
interface FixtureProps extends Props {
  german?: boolean;
}
let { german = false, value = $bindable(''), ...rest }: FixtureProps = $props();
if (untrack(() => german)) {
  setI18nContext(
    createI18nContext({
      locale: 'de',
      messages: {
        'commerce.customer.singular': 'Kunde',
        'commerce.customer.search': 'Kunden suchen',
        'commerce.select.new_customer': 'Neuer Kunde',
        'commerce.select.no_matches': 'Keine Treffer',
        'commerce.party.status_active': 'Aktiv',
        'commerce.customer.type_wholesale': 'Großhandel',
        'commerce.select.clear': '{label} entfernen',
      },
    }),
  );
}
</script>

<form data-testid="form">
  <CustomerSelect bind:value {...rest} />
</form>
