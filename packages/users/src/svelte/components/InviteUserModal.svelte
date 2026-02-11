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
    background: white;
    border-radius: 0.5rem;
    box-shadow:
      0 20px 25px -5px rgba(0, 0, 0, 0.1),
      0 10px 10px -5px rgba(0, 0, 0, 0.04);
    width: 100%;
    max-width: 28rem;
    max-height: 90vh;
    overflow: hidden;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    background: none;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    color: #6b7280;
  }

  .close-btn:hover {
    background: #f3f4f6;
    color: #111827;
  }

  .close-btn svg {
    width: 1.25rem;
    height: 1.25rem;
  }

  .body {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .error {
    padding: 0.75rem;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 0.375rem;
    color: #991b1b;
    font-size: 0.875rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  input[type='email'] {
    padding: 0.5rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }

  input[type='email']:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  input[type='email']:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .checkbox-field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .checkbox-field input {
    width: 1rem;
    height: 1rem;
    accent-color: #3b82f6;
  }

  .checkbox-field label {
    font-weight: 400;
  }

  .hint {
    font-size: 0.75rem;
    color: #6b7280;
    padding: 0.5rem;
    background: #f9fafb;
    border-radius: 0.25rem;
  }

  .footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    padding: 1rem 1.5rem;
    background: #f9fafb;
    border-top: 1px solid #e5e7eb;
  }

  button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #3b82f6;
    color: white;
    border: none;
  }

  .btn-primary:hover:not(:disabled) {
    background: #2563eb;
  }

  .btn-secondary {
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }

  .btn-secondary:hover:not(:disabled) {
    background: #f9fafb;
  }
</style>
