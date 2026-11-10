<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';

interface Props {
  message?: string;
}

const { message = 'Hello Federation!' }: Props = $props();
const { t } = useI18n();
</script>

<div class="smrt-test-component__root" data-smrt-component="TestComponent">
  <h3>{t(M['products.test_component.title'])}</h3>
  <p>{message}</p>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-test-component__root {
    padding: 1rem;
  }
}

@layer smrt.theme {
  .smrt-test-component__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-surface-container-low);
  }
}

</style>