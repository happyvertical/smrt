<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
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
  /** Application name shown as the brand above the card. */
  title?: string;
  /** Optional logo shown before the title. */
  logoSrc?: string;
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
  title = 'SMRT',
  logoSrc,
  askTenantName = false,
  action,
  enhance,
}: Props = $props();
const { t } = useI18n();
const link = $derived(
  data.link ??
    (!data.available ? 'unavailable' : data.token ? 'ready' : 'missing'),
);

function enhanceForm(form: HTMLFormElement) {
  const handle = enhance?.(form);
  return () => handle?.destroy?.();
}
</script>

<main class="smrt-owner-setup" data-smrt-component="OwnerSetupForm">
  <div class="smrt-owner-setup__brand" data-smrt-part="brand">
    {#if logoSrc}<img src={logoSrc} alt="" />{/if}
    <strong>{title}</strong>
  </div>
  <div class="smrt-owner-setup__card" data-smrt-part="panel">
  <Card padding="lg">
    <h1>
      {link === 'missing' || link === 'expired'
        ? t(M['ui.owner_setup.link_missing_heading'])
        : t(M['ui.owner_setup.heading'])}
    </h1>
    {#if link === 'unavailable'}
      <p data-owner-setup="unavailable">{t(M['ui.owner_setup.unavailable'])}</p>
    {:else if link === 'missing' || link === 'expired'}
      <div data-owner-setup="recovery">
        <p>{t(M['ui.owner_setup.link_missing_body'])}</p>
        <dl>
          <dt>{t(M['ui.owner_setup.recovery_open'])}</dt>
          <dd><code>pnpm app:open</code></dd>
          <dt>{t(M['ui.owner_setup.recovery_recover'])}</dt>
          <dd><code>pnpm app:recover</code></dd>
        </dl>
      </div>
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
  </Card>
  </div>
</main>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-owner-setup {
    display: grid;
    gap: var(--smrt-spacing-5);
    justify-items: center;
    align-content: center;
    min-block-size: 100dvh;
    box-sizing: border-box;
    padding: var(--smrt-spacing-6);
  }
  .smrt-owner-setup__card {
    inline-size: 100%;
    max-inline-size: 36rem;
  }
  .smrt-owner-setup__brand {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
    color: var(--smrt-color-on-surface);
  }
  .smrt-owner-setup__brand img {
    block-size: var(--smrt-control-target-min);
    inline-size: auto;
  }
  h1 {
    margin-block-start: 0;
  }
  form,
  dl {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  dl,
  dd {
    margin: 0;
  }
  dt {
    color: var(--smrt-color-on-surface-variant);
  }
  label {
    display: grid;
    gap: var(--smrt-spacing-2);
  }
  [role='alert'] {
    color: var(--smrt-color-error);
  }
}
</style>
