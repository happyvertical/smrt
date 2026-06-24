<script lang="ts">
import { RoleSelector } from '@happyvertical/smrt-ui';
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Role, Tenant } from '@happyvertical/smrt-users';
import { M } from '../i18n.js';

const { t } = useI18n();

export interface Props {
  open: boolean;
  tenant: Tenant;
  roles: Role[];
  onsubmit: (data: {
    email: string;
    roleId: string;
    sendEmail: boolean;
  }) => void;
  onclose: () => void;
  loading?: boolean;
}

const {
  open,
  tenant,
  roles,
  onsubmit,
  onclose,
  loading = false,
}: Props = $props();

const formId = $props.id();

let email = $state('');
let roleId = $state('');
let sendEmail = $state(true);
let error = $state('');

// Set default role to 'member' if available
$effect(() => {
  if (roles.length > 0 && !roleId) {
    const memberRole = roles.find((r) => r.slug === 'member');
    roleId = memberRole?.id ?? roles[0].id ?? '';
  }
});

function handleSubmit() {
  error = '';

  if (!email) {
    error = 'Email is required';
    return;
  }

  if (!roleId) {
    error = 'Please select a role';
    return;
  }

  onsubmit({ email, roleId, sendEmail });
}

function handleClose() {
  email = '';
  roleId = '';
  sendEmail = true;
  error = '';
  onclose();
}
</script>

<!--
  Adopts the smrt-ui Modal (native <dialog>.showModal()) for the focus trap,
  focus restore, top-layer rendering, and Escape handling that the previous
  hand-rolled dialog lacked (#1399 a11y blocker).
-->
<Modal
  {open}
  onClose={handleClose}
  size="sm"
  title={t(M['users.invite_user_modal.title'], { tenantName: tenant.name })}
  ariaLabel={t(M['users.invite_user_modal.title'], { tenantName: tenant.name })}
  closeOnBackdrop={!loading}
  closeOnEscape={!loading}
>
  <div class="invite-form-shell">
    <Form id={formId} class="invite-form" onsubmit={handleSubmit}>
      {#if error}
        <div class="error">{error}</div>
      {/if}

      <div class="field">
        <label for="invite-email">{t(M['users.invite_user_modal.email_address'])}</label>
        <Input
          id="invite-email"
          type="email"
          bind:value={email}
          placeholder={t(M['users.invite_user_modal.email_placeholder'])}
          disabled={loading}
          required
        />
      </div>

      <div class="field">
        <label for="invite-role">Role</label>
        <RoleSelector
          {roles}
          value={roleId}
          onchange={(id: string) => (roleId = id)}
          disabled={loading}
          showDescription
        />
      </div>

      <div class="checkbox-field">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input id="send-email" type="checkbox" bind:checked={sendEmail} disabled={loading} />
        <label for="send-email">{t(M['users.invite_user_modal.send_invitation_email'])}</label>
      </div>

      {#if !sendEmail}
        <div class="hint">
          {t(M['users.invite_user_modal.pending_hint'])}
        </div>
      {/if}
    </Form>
  </div>

  {#snippet footer()}
    <Button variant="secondary" type="button" onclick={handleClose} disabled={loading}>
      Cancel
    </Button>
    <Button variant="primary" type="submit" form={formId} disabled={loading}>
      {#if loading}
        {t(M['users.invite_user_modal.sending'])}
      {:else}
        {t(M['users.invite_user_modal.send_invite'])}
      {/if}
    </Button>
  {/snippet}
</Modal>

<style>
  /* The dialog chrome (backdrop, surface, header, footer bar, close button) is
     supplied by the smrt-ui Modal. Only the form-content + footer-button styles
     live here. */
  .invite-form-shell :global(.invite-form) {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .error {
    padding: var(--smrt-spacing-sm, 0.75rem);
    background: var(--smrt-color-error-container, #ffdad6);
    border: 1px solid var(--smrt-color-error, #ba1a1a);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-error-container, #410002);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }

  .checkbox-field input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--smrt-color-primary, #005ac1);
  }

  .checkbox-field label {
    font-weight: var(--smrt-typography-weight-normal, 400);
  }

  .hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    padding: var(--smrt-spacing-sm, 0.5rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
</style>
