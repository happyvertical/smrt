<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';
import { UserStatus } from '@happyvertical/smrt-types';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { User } from '@happyvertical/smrt-users';
import { M } from '../i18n.js';

const { t } = useI18n();

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

function getInitialFormState() {
  return {
    name: profile?.name ?? '',
    email: user?.email ?? '',
    status: user?.status ?? UserStatus.ACTIVE,
    user,
    profile,
  };
}

const initialFormState = getInitialFormState();
let name = $state(initialFormState.name);
let email = $state(initialFormState.email);
let status = $state(initialFormState.status);
let appliedUser: User | null = initialFormState.user;
let appliedProfile: Profile | null = initialFormState.profile;

// Drive the options from the enum so the form can never offer a value that
// isn't a real UserStatus (previously offered `deactivated`, which is not an
// enum member, and omitted `inactive`).
const statusOptions = Object.values(UserStatus).map((value) => ({
  value,
  label: value.charAt(0).toUpperCase() + value.slice(1),
}));

$effect(() => {
  if (appliedUser === user && appliedProfile === profile) {
    return;
  }

  appliedUser = user;
  appliedProfile = profile;
  name = profile?.name ?? '';
  email = user?.email ?? '';
  status = user?.status ?? UserStatus.ACTIVE;
});

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
      <span class="hint">{t(M['users.user_form.email_cannot_be_changed'])}</span>
    {/if}
  </div>

  <div class="field">
    <label for="status">Status</label>
    <select id="status" bind:value={status} disabled={loading}>
      {#each statusOptions as option (option.value)}
        <option value={option.value}>{option.label}</option>
      {/each}
    </select>
  </div>

  <div class="actions">
    {#if oncancel}
      <Button variant="secondary" type="button" onclick={oncancel} disabled={loading}>
        Cancel
      </Button>
    {/if}
    <Button variant="primary" type="submit" disabled={loading}>
      {#if loading}
        Saving...
      {:else}
        {user ? 'Update User' : 'Create User'}
      {/if}
    </Button>
  </div>
</form>

<style>
  .user-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  label {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  input,
  select {
    padding: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    transition: border-color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px var(--smrt-color-primary-container, rgba(0, 90, 193, 0.1));
  }

  input:disabled,
  select:disabled {
    background: var(--smrt-color-surface-container, #f3f4f6);
    cursor: not-allowed;
  }

  .hint {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-sm, 0.5rem);
    margin-top: var(--smrt-spacing-sm, 0.5rem);
  }

  @media (prefers-reduced-motion: reduce) {
    input,
    select {
      transition: none;
    }
  }
</style>
