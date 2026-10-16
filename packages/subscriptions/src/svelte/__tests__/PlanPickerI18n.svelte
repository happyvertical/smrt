<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import PlanPicker, { type PlanPickerPlan } from '../PlanPicker.svelte';

let { plans }: { plans: PlanPickerPlan[] } = $props();
setI18nContext(
  createI18nContext({
    locale: 'fr',
    messages: {
      'subscriptions.picker.free': 'Gratuit',
      'subscriptions.picker.pay_what_you_can': 'Prix libre',
      'subscriptions.picker.minimum': 'Au moins {amount} par {interval}',
      'subscriptions.picker.suggested': 'Suggestion {amount} par {interval}',
    },
  }),
);
</script>
<PlanPicker {plans} />
