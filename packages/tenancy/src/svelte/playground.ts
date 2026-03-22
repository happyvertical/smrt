import { TENANCY_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleTenants = [
  {
    id: 'tenant-riverstone',
    name: 'Riverstone Newsroom',
    slug: 'riverstone-newsroom',
    status: 'active',
  },
  {
    id: 'tenant-harbor',
    name: 'Harbor Labs',
    slug: 'harbor-labs',
    status: 'suspended',
  },
];

const sampleMemberships = [
  {
    id: 'membership-riverstone',
    tenantId: 'tenant-riverstone',
  },
  {
    id: 'membership-harbor',
    tenantId: 'tenant-harbor',
  },
];

const loadTenantCard = () => import('./components/TenantCard.svelte');
const loadTenantSwitcher = () => import('./components/TenantSwitcher.svelte');

export default {
  packageName: '@happyvertical/smrt-tenancy',
  displayName: TENANCY_MODULE_META.displayName,
  description: TENANCY_MODULE_META.description,
  moduleMeta: TENANCY_MODULE_META,
  entries: [
    {
      id: 'tenant-card',
      title: 'Tenant Card',
      description:
        'Tenant identity and status card with optional membership count and actions.',
      loadComponent: loadTenantCard,
      order: 1,
      props: {
        tenant: sampleTenants[0],
        memberCount: 18,
        selected: true,
        actions: true,
        onclick: noop,
        onedit: noop,
        ondelete: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'tenant-switcher',
      title: 'Tenant Switcher',
      description:
        'Membership-aware tenant selector used for multi-tenant application shells.',
      loadComponent: loadTenantSwitcher,
      order: 2,
      props: {
        memberships: sampleMemberships,
        tenants: new Map(sampleTenants.map((tenant) => [tenant.id, tenant])),
        currentTenantId: 'tenant-riverstone',
        onchange: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
