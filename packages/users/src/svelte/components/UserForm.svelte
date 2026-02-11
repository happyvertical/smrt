<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';
import { UserStatus } from '@happyvertical/smrt-types';
import type { User } from '@happyvertical/smrt-users';

export interface Props {
  user?: User | null;
  profile?: Profile | null;
  onsubmit: (data: { name: string; email: string; status: UserStatus }) => void;
  oncancel?: () => void;
  loading?: boolean;
}

const {
  user = null,
  profile = null,
  onsubmit,
  oncancel,
  loading = false,
}: Props = $props();

let name = $state(profile?.name ?? '');
let email = $state(user?.email ?? '');
let status: UserStatus = $state(user?.status ?? UserStatus.ACTIVE);

function handleSubmit(e: Event) {
  e.preventDefault();
  onsubmit({ name, email, status });
}
</script>

<form class="user-form" onsubmit={handleSubmit}>
  <div class="field">
    <label for="name">Name</label>
    <input id="name" type="text" bind:value={name} required disabled={loading} />
  </div>

  <div class="field">
    <label for="email">Email</label>
    <input id="email" type="email" bind:value={email} required disabled={loading || !!user} />
    {#if user}
      <span class="hint">Email cannot be changed after creation</span>
    {/if}
  </div>

  <div class="field">
    <label for="status">Status</label>
    <select id="status" bind:value={status} disabled={loading}>
      <option value="active">Active</option>
      <option value="pending">Pending</option>
      <option value="suspended">Suspended</option>
      <option value="deactivated">Deactivated</option>
    </select>
  </div>

  <div class="actions">
    {#if oncancel}
      <button type="button" class="btn-secondary" onclick={oncancel} disabled={loading}>
        Cancel
      </button>
    {/if}
    <button type="submit" class="btn-primary" disabled={loading}>
      {#if loading}
        Saving...
      {:else}
        {user ? 'Update User' : 'Create User'}
      {/if}
    </button>
  </div>
</form>

<style>
  .user-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font-size: 0.875rem;
    font-weight: 500;
    color: #374151;
  }

  input,
  select {
    padding: 0.5rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    font-size: 0.875rem;
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
  }

  input:disabled,
  select:disabled {
    background: #f3f4f6;
    cursor: not-allowed;
  }

  .hint {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
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
