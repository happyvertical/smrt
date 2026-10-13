<script lang="ts">
import '@happyvertical/smrt-ui/themes/styles/all.css';
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import '@happyvertical/smrt-ui/themes/styles/base.css';
import { onMount } from 'svelte';
import { page } from '$app/state';
import { AppShell } from '@happyvertical/smrt-svelte/app';
import { ShellDockTool } from '@happyvertical/smrt-svelte/workspace';
import { Tabs } from '@happyvertical/smrt-ui';
import { DataTable } from '@happyvertical/smrt-ui/data';
import {
  Alert,
  ToastViewport,
  createToaster,
} from '@happyvertical/smrt-ui/feedback';
import {
  FormGroup,
  Input,
  Select,
  Textarea,
  Toggle,
} from '@happyvertical/smrt-ui/forms';
import {
  Badge,
  Button,
  Card,
  Chip,
  Dropdown,
} from '@happyvertical/smrt-ui/ui';

const PRESETS = [
  'material',
  'glass',
  'studio',
  'smrt',
  'happyvertical',
] as const;
type Preset = (typeof PRESETS)[number];

// ?theme=<preset>&scheme=light|dark — read from the URL so SSR and the first
// client render agree.
const presetParam = $derived(page.url.searchParams.get('theme'));
const schemeParam = $derived(page.url.searchParams.get('scheme'));
const preset = $derived<Preset>(
  (PRESETS as readonly string[]).includes(presetParam ?? '')
    ? (presetParam as Preset)
    : 'material',
);
const scheme = $derived<'light' | 'dark'>(
  schemeParam === 'dark' ? 'dark' : 'light',
);

const nav = [
  { href: '/theme-gallery', label: 'Overview', icon: 'home' },
  { href: '/theme-gallery#schedule', label: 'Schedule', icon: 'calendar' },
  { href: '/theme-gallery#people', label: 'People', icon: 'users' },
  { href: '/theme-gallery#settings', label: 'Settings', icon: 'settings' },
];
const user = { id: 'u1', name: 'Ada Owner', email: 'ada@example.com' };

let name = $state('Ada Lovelace');
let email = $state('ada@example.com');
let role = $state('editor');
let notes = $state('Quarterly review notes go here.');
let notify = $state(true);
let tab = $state('overview');

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity', count: 12 },
  { id: 'billing', label: 'Billing' },
];
const menu = [
  { id: 'edit', label: 'Edit' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'archive', label: 'Archive' },
];

interface Row {
  id: string;
  account: string;
  region: string;
  units: number;
  amount: string;
}
const rows: Row[] = [
  { id: 'r1', account: 'Northwind', region: 'West', units: 1204, amount: '18,432.50' },
  { id: 'r2', account: 'Contoso', region: 'East', units: 87, amount: '1,204.00' },
  { id: 'r3', account: 'Fabrikam', region: 'North', units: 15320, amount: '214,980.75' },
  { id: 'r4', account: 'Tailspin', region: 'South', units: 640, amount: '9,120.10' },
];
const columns = [
  { id: 'account', label: 'Account', accessor: 'account' },
  { id: 'region', label: 'Region', accessor: 'region' },
  { id: 'units', label: 'Units', accessor: 'units', align: 'right' as const },
  { id: 'amount', label: 'Amount', accessor: 'amount', align: 'right' as const },
];
let selected = $state(new Set<string | number>(['r3']));

const toaster = createToaster();
let menuHost: HTMLElement | undefined = $state();
let ready = $state(false);

onMount(() => {
  // Open the menu and raise one persistent toast so the screenshot shows both.
  menuHost
    ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
    ?.click();
  toaster.success('Settings saved', { duration: 0 });
  ready = true;
});
</script>

<svelte:head><title>Theme gallery</title></svelte:head>

<AppShell
  title="Gallery"
  {nav}
  currentHref="/theme-gallery"
  {user}
  {preset}
  colorScheme={scheme}
  storageKey="smrt-theme-gallery"
  dockToggles={[{ tool: 'notes', label: 'Notes', icon: 'layers' }]}
  hotkeys={false}
>
  {#snippet dock()}
    <ShellDockTool id="notes" label="Notes" render={dockBody} />
  {/snippet}

  <div class="gallery" data-testid="theme-gallery" data-ready={ready}>
    <div class="heads">
      <h1>Heading one</h1>
      <h2>Heading two</h2>
      <h3>Heading three</h3>
      <p>Body copy shows the preset's text face, colour and rhythm.</p>
    </div>

    <Card>
      {#snippet header()}<strong>Account details</strong>{/snippet}
      <form class="form" onsubmit={(e) => e.preventDefault()}>
        <FormGroup label="Name"><Input name="name" bind:value={name} /></FormGroup>
        <FormGroup label="Email">
          <Input name="email" type="email" bind:value={email} />
        </FormGroup>
        <FormGroup label="Role">
          <Select name="role" bind:value={role}>
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </Select>
        </FormGroup>
        <FormGroup label="Notes">
          <Textarea name="notes" rows={2} bind:value={notes} />
        </FormGroup>
        <Toggle label="Email notifications" bind:checked={notify} />
        <div class="buttons">
          <Button type="submit">Save</Button>
          <Button variant="secondary">Duplicate</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="danger">Delete</Button>
        </div>
      </form>
    </Card>

    <Tabs {tabs} active={tab} onchange={(id) => (tab = id)} aria-label="Sections" />

    <div class="chips">
      <Chip label="Design" />
      <Chip label="Selected" selectable selected />
      <Chip label="Removable" closeable />
      <Badge>Neutral</Badge>
      <Badge variant="success">Active</Badge>
      <Badge variant="warning">Pending</Badge>
      <Badge variant="error">Failed</Badge>
    </div>

    <DataTable
      data={rows}
      {columns}
      rowKey="id"
      selectable
      bind:selected
      hoverable
      caption="Quarterly accounts"
    />

    <div class="alerts">
      <Alert title="Information">The index refreshes in the background.</Alert>
      <Alert variant="success" title="Published">Your changes are live.</Alert>
      <Alert variant="warning" title="Review needed">Two fields use defaults.</Alert>
      <Alert variant="error" title="Connection lost">Reconnect to submit.</Alert>
    </div>

    <div class="menu" bind:this={menuHost}>
      <Dropdown label="Actions" items={menu} />
    </div>
  </div>

  <ToastViewport {toaster} />
</AppShell>

{#snippet dockBody()}
  <p class="dock-note">Dock tool content.</p>
{/snippet}

<style>
  @layer smrt.reset, smrt.structure, smrt.theme;
  @layer smrt.theme {
    .gallery {
      display: grid;
      gap: var(--smrt-spacing-6);
      padding: var(--smrt-spacing-6);
      max-width: 60rem;
    }
    .heads h1,
    .heads h2,
    .heads h3,
    .heads p {
      margin: 0 0 var(--smrt-spacing-2);
    }
    .form {
      display: grid;
      gap: var(--smrt-spacing-4);
    }
    .buttons,
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--smrt-spacing-3);
      align-items: center;
    }
    .alerts {
      display: grid;
      gap: var(--smrt-spacing-2);
    }
    .menu {
      min-height: 11rem;
    }
  }
</style>
