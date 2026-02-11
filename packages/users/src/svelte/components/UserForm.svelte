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
    gap: var(--md-sys-spacing-md, 1rem);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font: var(--md-sys-typescale-body-medium-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--md-sys-color-on-surface-variant, #43474e);
  }

  input,
  select {
    padding: var(--md-sys-spacing-sm, 0.5rem) var(--md-sys-spacing-md, 0.75rem);
    border: 1px solid var(--md-sys-color-outline-variant, #c4c6cf);
    border-radius: var(--md-sys-shape-corner-medium, 0.5rem);
    font: var(--md-sys-typescale-body-medium-font, 0.875rem / 1.25 sans-serif);
    transition: border-color var(--md-sys-motion-duration-short2, 150ms) var(--md-sys-motion-easing-standard, ease);
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--md-sys-color-primary, #005ac1);
    box-shadow: 0 0 0 3px var(--md-sys-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  input:disabled,
  select:disabled {
    background: var(--md-sys-color-surface-container, #f3f4f6);
    cursor: not-allowed;
  }

  .hint {
    font: var(--md-sys-typescale-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--md-sys-color-on-surface-variant, #43474e);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--md-sys-spacing-sm, 0.5rem);
    margin-top: var(--md-sys-spacing-sm, 0.5rem);
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
    input,
    select,
    button {
      transition: none;
    }
  }
</style>
