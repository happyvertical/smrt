<script lang="ts">
import { createI18nContext, setI18nContext } from '../../../i18n/index.js';
import CurrencyDisplay from '../CurrencyDisplay.svelte';

setI18nContext(
  createI18nContext({
    locale: 'fr',
    messages: {
      'ui.currency_display.invalid_code': 'Code monétaire invalide : {code}',
      'ui.currency_display.invalid_minor_unit_amount':
        'Montant en unité mineure invalide',
      'ui.currency_display.no_minor_unit': 'Devise sans unité mineure : {code}',
    },
  }),
);
</script>

<CurrencyDisplay amount={12345} currency="ZZZ" />
<CurrencyDisplay amount={12345} currency="XAU" />
<CurrencyDisplay amount={1.5} currency="CAD" />
