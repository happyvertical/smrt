<script lang="ts">
import { RoleSelector } from '@happyvertical/smrt-svelte';
import type { Role, Tenant } from '@happyvertical/smrt-users';

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
  <div class="modal-backdrop" onclick={handleBackdrop} role="dialog" aria-modal="true">
    <div class="modal">
      <div class="header">
        <h2>Invite User to {tenant.name}</h2>
        <button type="button" class="close-btn" onclick={handleClose} aria-label="Close">
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
            <label for="invite-email">Email address</label>
            <input
              id="invite-email"
              type="email"
              bind:value={email}
              placeholder="user@example.com"
              disabled={loading}
              required
            />
          </div>

          <div class="field">
            <label for="invite-role">Role</label>
            <RoleSelector {roles} value={roleId} onchange={(id) => (roleId = id)} disabled={loading} showDescription />
          </div>

          <div class="checkbox-field">
            <input id="send-email" type="checkbox" bind:checked={sendEmail} disabled={loading} />
            <label for="send-email">Send invitation email</label>
          </div>

          {#if !sendEmail}
            <div class="hint">
              The user will be added with pending status. Share the invite link manually.
            </div>
          {/if}
        </div>

        <div class="footer">
          <button type="button" class="btn-secondary" onclick={handleClose} disabled={loading}>
            Cancel
          </button>
          <button type="submit" class="btn-primary" disabled={loading}>
            {#if loading}
              Sending...
            {:else}
              Send Invite
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
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 100;
  }

  .modal {
    background: var(--md-sys-color-surface, white);
    border-radius: var(--md-sys-shape-corner-large, 0.5rem);
    box-shadow: var(--md-sys-elevation-level3, 0 20px 25px -5px rgba(0, 0, 0, 0.1));
    width: 100%;
    max-width: 28rem;
    max-height: 90vh;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--md-sys-spacing-md, 1rem) var(--md-sys-spacing-lg, 1.5rem);
    border-bottom: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
  }

  h2 {
    margin: 0;
    font: var(--md-sys-typescale-title-large-font, 600 1.125rem / 1.25 sans-serif);
    color: var(--md-sys-color-on-surface, #1a1c1e);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: none;
    border: none;
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    cursor: pointer;
    color: var(--md-sys-color-on-surface-variant, #43474e);
    transition: background-color var(--md-sys-motion-duration-short2, 150ms) var(--md-sys-motion-easing-standard, ease);
  }

  .close-btn:hover {
    background: var(--md-sys-color-surface-container, #f3f4f6);
    color: var(--md-sys-color-on-surface, #1a1c1e);
  }

  .close-btn svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .body {
    padding: var(--md-sys-spacing-lg, 1.5rem);
    display: flex;
    flex-direction: column;
    gap: var(--md-sys-spacing-md, 1rem);
  }

  .error {
    padding: var(--md-sys-spacing-sm, 0.75rem);
    background: var(--md-sys-color-error-container, #ffdad6);
    border: 1px solid var(--md-sys-color-error, #ba1a1a);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    color: var(--md-sys-color-on-error-container, #410002);
    font: var(--md-sys-typescale-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label {
    font: var(--md-sys-typescale-body-medium-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--md-sys-color-on-surface-variant, #43474e);
  }

  input[type='email'] {
    padding: var(--md-sys-spacing-sm, 0.5rem) var(--md-sys-spacing-md, 0.75rem);
    border: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    font: var(--md-sys-typescale-body-medium-font, 0.875rem / 1.25 sans-serif);
    transition: border-color var(--md-sys-motion-duration-short2, 150ms) var(--md-sys-motion-easing-standard, ease);
  }

  input[type='email']:focus {
    outline: none;
    border-color: var(--md-sys-color-primary, #005ac1);
    box-shadow: 0 0 0 3px var(--md-sys-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  input[type='email']:disabled {
    background: var(--md-sys-color-surface-container, #f3f4f6);
    cursor: not-allowed;
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: var(--md-sys-spacing-sm, 0.5rem);
  }

  .checkbox-field input {
    width: 1rem;
    height: 1rem;
    accent-color: var(--md-sys-color-primary, #005ac1);
  }

  .checkbox-field label {
    font-weight: var(--md-sys-typescale-weight-regular, 400);
  }

  .hint {
    font: var(--md-sys-typescale-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--md-sys-color-on-surface-variant, #43474e);
    padding: var(--md-sys-spacing-sm, 0.5rem);
    background: var(--md-sys-color-surface-container-low, #f9fafb);
    border-radius: var(--md-sys-shape-corner-small, 0.25rem);
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--md-sys-spacing-sm, 0.75rem);
    padding: var(--md-sys-spacing-md, 1rem) var(--md-sys-spacing-lg, 1.5rem);
    background: var(--md-sys-color-surface-container-low, #f9fafb);
    border-top: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
  }

  button {
    padding: var(--md-sys-spacing-sm, 0.5rem) var(--md-sys-spacing-md, 1rem);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    font: var(--md-sys-typescale-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    transition: all var(--md-sys-motion-duration-short2, 150ms) var(--md-sys-motion-easing-standard, ease);
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--md-sys-color-primary, #005ac1);
    color: var(--md-sys-color-on-primary, #ffffff);
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: var(--md-sys-color-primary-container, #005ac1);
    opacity: 0.9;
  }

  .btn-secondary {
    background: var(--md-sys-color-surface, white);
    color: var(--md-sys-color-on-surface-variant, #43474e);
    border: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--md-sys-color-surface-container-low, #f9fafb);
  }

  @media (prefers-reduced-motion: reduce) {
    button,
    input[type='email'],
    .close-btn {
      transition: none;
    }
  }
</style>
