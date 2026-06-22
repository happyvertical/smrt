<script lang="ts">
import { RoleSelector } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
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

function handleSubmit(e: Event) {
  e.preventDefault();
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

function handleBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) {
    handleClose();
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open) {
    handleClose();
  }
}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="modal-backdrop">
    <button
      type="button"
      class="modal-overlay"
      aria-label={t(M['users.invite_user_modal.close_invite_dialog'])}
      onclick={handleClose}
    ></button>
    <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
      <div class="header">
        <h2>{t(M['users.invite_user_modal.title'], { tenantName: tenant.name })}</h2>
        <button type="button" class="close-btn" onclick={handleClose} aria-label={t(M['users.invite_user_modal.close'])}>
          <svg viewBox="0 0 20 20" fill="currentColor">
            <path
              d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
            />
          </svg>
        </button>
      </div>

      <form onsubmit={handleSubmit}>
        <div class="body">
          {#if error}
            <div class="error">{error}</div>
          {/if}

          <div class="field">
            <label for="invite-email">{t(M['users.invite_user_modal.email_address'])}</label>
            <input
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
            <input id="send-email" type="checkbox" bind:checked={sendEmail} disabled={loading} />
            <label for="send-email">{t(M['users.invite_user_modal.send_invitation_email'])}</label>
          </div>

          {#if !sendEmail}
            <div class="hint">
              {t(M['users.invite_user_modal.pending_hint'])}
            </div>
          {/if}
        </div>

        <div class="footer">
          <button type="button" class="btn-secondary" onclick={handleClose} disabled={loading}>
            Cancel
          </button>
          <button type="submit" class="btn-primary" disabled={loading}>
            {#if loading}
              {t(M['users.invite_user_modal.sending'])}
            {:else}
              {t(M['users.invite_user_modal.send_invite'])}
            {/if}
          </button>
        </div>
      </form>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: var(--smrt-z-index-dialog, 1300);
  }

  .modal-overlay {
    position: absolute;
    inset: 0;
    border: none;
    background: var(--smrt-color-scrim, rgba(0, 0, 0, 0.5));
    cursor: pointer;
  }

  .modal {
    position: relative;
    background: var(--smrt-color-surface, white);
    border-radius: var(--smrt-radius-large, 0.5rem);
    box-shadow: var(--smrt-elevation-3, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
    width: 100%;
    max-width: 28rem;
    max-height: 90vh;
    overflow: hidden;
    z-index: 1;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-md, 1rem) var(--smrt-spacing-lg, 1.5rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  h2 {
    margin: 0;
    font: var(--smrt-typography-title-large-font, 600 1.125rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: none;
    border: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    cursor: pointer;
    color: var(--smrt-color-on-surface-variant, #43474e);
    transition: background-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .close-btn:hover {
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .close-btn svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .body {
    padding: var(--smrt-spacing-lg, 1.5rem);
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

  input[type='email'] {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    transition: border-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  input[type='email']:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  input[type='email']:disabled {
    background: var(--smrt-color-surface-container, #f3f4f6);
    cursor: not-allowed;
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

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-sm, 0.75rem);
    padding: var(--smrt-spacing-md, 1rem) var(--smrt-spacing-lg, 1.5rem);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  button {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 1rem);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--smrt-color-primary-container, #005ac1);
    opacity: 0.9;
  }

  .btn-secondary {
    background: var(--smrt-color-surface, white);
    color: var(--smrt-color-on-surface-variant, #43474e);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low, #f9fafb);
  }

  @media (prefers-reduced-motion: reduce) {
    button,
    input[type='email'],
    .close-btn {
      transition: none;
    }
  }
</style>
