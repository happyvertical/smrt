<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.workspace.js';
import type {
  OwnerSetupData,
  OwnerSetupFormResult,
} from './owner-setup-types.js';

interface Props {
  /** The route's `load` data. The token is rendered only as a hidden field. */
  data: OwnerSetupData;
  /** The route's `form` prop (action failure data). */
  form?: OwnerSetupFormResult | null;
  /** Also ask for an optional workspace name (field `tenantName`). */
  askTenantName?: boolean;
  /** Form action URL; omit to post to the current route's default action. */
  action?: string;
  /**
   * SvelteKit's `enhance` from `$app/forms`, for progressive enhancement.
   * Optional: without it the form is a plain POST that works without JS.
   */
  enhance?: (form: HTMLFormElement) => { destroy?: () => void } | void;
}

let {
  data,
  form = null,
  askTenantName = false,
  action,
  enhance,
}: Props = $props();
const { t } = useI18n();

function enhanceForm(form: HTMLFormElement) {
  const handle = enhance?.(form);
  return () => handle?.destroy?.();
}
</script>

<main class="smrt-owner-setup">
  <h1>{t(M['ui.owner_setup.heading'])}</h1>
  {#if !data.available}
    <p data-owner-setup="unavailable">{t(M['ui.owner_setup.unavailable'])}</p>
  {:else}
    <p>{t(M['ui.owner_setup.intro'])}</p>
    {#if form?.message}<p role="alert" data-owner-setup="error">{form.message}</p>{/if}
    <!-- raw-primitive-allow: native POST form so owner setup works without JavaScript; the host's SvelteKit `enhance` is attached when available -->
    <form method="POST" {action} {@attach enhanceForm}>
      <!-- raw-primitive-allow: hidden, non-interactive carrier for the single-use bootstrap token -->
      <input type="hidden" name="token" value={data.token} />
      <label>
        {t(M['ui.owner_setup.name'])}
        <Input name="name" autocomplete="name" required />
      </label>
      <label>
        {t(M['ui.owner_setup.email'])}
        <Input name="email" type="email" autocomplete="email" required />
      </label>
      {#if askTenantName}
        <label>
          {t(M['ui.owner_setup.tenant_name'])}
          <Input name="tenantName" autocomplete="organization" />
        </label>
      {/if}
      <Button type="submit">{t(M['ui.owner_setup.submit'])}</Button>
    </form>
  {/if}
</main>

<style>
  .smrt-owner-setup {
    max-width: 36rem;
    margin: 4rem auto;
    padding: 1.5rem;
  }
  form {
    display: grid;
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
  }
  [role='alert'] {
    color: var(--smrt-color-error, #b3261e);
  }
</style>
