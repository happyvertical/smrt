<script lang="ts">
import type { Role } from '@happyvertical/smrt-users';

interface Props {
  role: Role;
  size?: 'sm' | 'md' | 'lg';
}

const { role, size = 'md' }: Props = $props();

const colors: Record<string, { bg: string; text: string }> = {
  owner: { bg: '#fef3c7', text: '#92400e' },
  admin: { bg: '#dbeafe', text: '#1e40af' },
  member: { bg: '#d1fae5', text: '#065f46' },
  viewer: { bg: '#f3f4f6', text: '#374151' },
};

const color = $derived(
  colors[role.slug ?? ''] ?? { bg: '#e5e7eb', text: '#374151' },
);
</script>

<span
  class="role-badge"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
  style:background-color={color.bg}
  style:color={color.text}
>
  {role.name}
</span>

<style>
  .role-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    border-radius: 9999px;
    white-space: nowrap;
  }

  .role-badge.sm {
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
  }

  .role-badge.lg {
    padding: 0.375rem 1rem;
    font-size: 1rem;
  }
</style>
