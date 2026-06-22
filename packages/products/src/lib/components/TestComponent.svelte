<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';

interface Props {
  message?: string;
}

const { message = 'Hello Federation!' }: Props = $props();
const { t } = useI18n();
</script>

<div class="test-component">
  <h3>{t(M['products.test_component.title'])}</h3>
  <p>{message}</p>
</div>

<style>
  .test-component {
    padding: 1rem;
    border: 1px solid var(--smrt-color-outline-variant, #ccc);
    border-radius: var(--smrt-radius-sm, 4px);
    background: var(--smrt-color-surface-container-low, #f9f9f9);
  }
</style>