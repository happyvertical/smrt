<script lang="ts">
import type { User } from '../../../state/app-state.js';
import type { PaletteProvider } from '../../command-palette/types.js';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type {
  ShellNavItem,
  ShellPanelDefaults,
} from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import type { AppShellAccountMenu } from '../slot-item.js';

let {
  user = {
    id: 'u1',
    email: 'ada@example.com',
    name: 'Ada Lovelace',
  } as unknown as User,
  accountMenu,
  colorSchemeToggle,
  commandPalette,
  settingsHref = '/settings',
  signOutHref,
  onSignOut,
  config = { left: { initial: 'expanded' } },
  layout,
  edgeToggles = false,
  title = 'Planner',
}: {
  user?: User | null;
  accountMenu?: AppShellAccountMenu;
  colorSchemeToggle?: boolean | { slot?: never };
  commandPalette?: { providers: PaletteProvider[]; placeholder?: string };
  settingsHref?: string;
  signOutHref?: string;
  onSignOut?: () => void | Promise<void>;
  config?: ShellPanelDefaults;
  layout?: ShellLayout | null;
  edgeToggles?: boolean | Record<string, boolean>;
  title?: string;
} = $props();

const nav: ShellNavItem[] = [
  { href: '/posts', label: 'Posts' },
  { href: '/users', label: 'Users' },
];
</script>

<AppShell
  {title}
  {nav}
  {user}
  {accountMenu}
  {colorSchemeToggle}
  {commandPalette}
  {settingsHref}
  {signOutHref}
  {onSignOut}
  {config}
  {layout}
  {edgeToggles}
>
  <p>Main content</p>
</AppShell>
