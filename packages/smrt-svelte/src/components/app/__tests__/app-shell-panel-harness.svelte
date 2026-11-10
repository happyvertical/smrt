<script lang="ts">
import type { User } from '../../../state/app-state.js';
import type { ShellPanelDefaults } from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import type { AppShellAccountMenu } from '../slot-item.js';

let {
  panelOpen = $bindable(true),
  phoneTabBar = false,
  accountMenu = {
    items: [
      { id: 'approvals', label: 'Approvals', href: '/approvals', badge: 3 },
      { id: 'history', label: 'History', href: '/history' },
    ],
    theme: true,
  } as AppShellAccountMenu,
  config = { left: { initial: 'expanded' } } as ShellPanelDefaults,
  withPanel = true,
  currentHref = '/',
  edgeToggles = false,
  sidebarFooterDivider = true,
  voiceState = 'off',
  onvoice,
}: {
  panelOpen?: boolean;
  phoneTabBar?: boolean;
  accountMenu?: AppShellAccountMenu;
  config?: ShellPanelDefaults;
  withPanel?: boolean;
  currentHref?: string;
  edgeToggles?: boolean;
  sidebarFooterDivider?: boolean;
  voiceState?: 'off' | 'on' | 'unavailable';
  onvoice?: () => void;
} = $props();

const user = {
  id: 'u1',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
} as unknown as User;
const nav = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/customers', label: 'Customers' },
];
</script>

<AppShell
  title="My app"
  {nav}
  {user}
  {accountMenu}
  {config}
  {phoneTabBar}
  {edgeToggles}
  {sidebarFooterDivider}
  {currentHref}
  settingsHref="/settings"
  colorSchemeToggle={false}
  panel={withPanel ? chat : undefined}
  bind:panelOpen
  panelLabel="Assistant chat"
  panelToggle={withPanel ? { label: 'Assistant' } : false}
  voiceToggle={{ label: 'Voice', state: voiceState, unavailableLabel: 'Voice (not available yet)', onpress: () => onvoice?.() }}
>
  <p>Main content</p>
</AppShell>

{#snippet chat()}<p data-testid="chat-body">chat body</p>{/snippet}
