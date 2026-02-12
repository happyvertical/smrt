<script>
const components = [
  {
    category: 'Users',
    items: [
      'UserAvatar',
      'UserCard',
      'UserList',
      'UserForm',
      'InviteUserModal',
    ],
  },
  { category: 'Roles', items: ['RoleBadge', 'RoleSelector'] },
  { category: 'Tenants', items: ['TenantCard', 'TenantSwitcher'] },
  { category: 'Auth', items: ['UserMenu'] },
  { category: 'Memberships', items: ['MembershipCard', 'MembershipList'] },
  { category: 'Permissions', items: ['PermissionCheck'] },
  {
    category: 'Forms',
    items: [
      'Form',
      'TextInput',
      'TextareaInput',
      'NumberInput',
      'PhoneInput',
      'SelectInput',
      'DateTimeInput',
      'DateRangeInput',
      'CheckboxInput',
      'AddressInput',
      'MoneyInput',
      'MeasurementInput',
      'SearchInput',
      'Toggle',
    ],
  },
  {
    category: 'Data',
    items: ['DataTable'],
  },
  {
    category: 'Foundation',
    items: ['ThemeProvider', 'useTheme', 'Ripple Action'],
  },
  {
    category: '🎨 NEW: Themes',
    items: [
      'Material Theme',
      'Glass Theme',
      'Studio Theme',
      'ThemeSwitcher',
      'ColorSchemeToggle',
    ],
  },
  {
    category: 'Display',
    items: [
      'ConfidenceBadge',
      'CurrencyDisplay',
      'DateDisplay',
      'StatusBadge',
      'Icon',
    ],
  },
  {
    category: 'Layout',
    items: ['EmptyState', 'PageHeader', 'SummaryCard'],
  },
  {
    category: 'Navigation',
    items: ['FilterChips', 'Tabs'],
  },
  {
    category: 'Feedback',
    items: ['ConfirmDialog', 'LoadingOverlay', 'Modal', 'ProgressBar'],
  },
  {
    category: 'Commerce',
    items: [
      'InvoiceCard',
      'InvoiceHeader',
      'InvoiceLineItems',
      'InvoiceTotals',
      'InvoiceActions',
      'UnbilledItems',
    ],
  },
  {
    category: 'AI',
    items: [
      'smrt',
      'AILoadingOverlay',
      'CapabilityGate',
      'DownloadProgress',
      'VoiceInput',
    ],
  },
];
</script>

<h1>SMRT Svelte Components</h1>
<p class="intro">
  A Svelte 5 component library for user management, auth, and multi-tenancy.
</p>

<div class="grid">
  {#each components as { category, items }}
    <div class="card">
      <h2>{category}</h2>
      <ul>
        {#each items as item}
          <li>{item}</li>
        {/each}
      </ul>
    </div>
  {/each}
</div>

<style>
  h1 {
    font-size: 2rem;
    margin-bottom: 8px;
  }

  .intro {
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 32px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }

  .card {
    background: var(--smrt-color-surface);
    border-radius: 8px;
    padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .card h2 {
    font-size: 1rem;
    color: var(--smrt-color-primary);
    margin-bottom: 12px;
  }

  .card ul {
    list-style: none;
  }

  .card li {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface);
    padding: 4px 0;
  }
</style>
