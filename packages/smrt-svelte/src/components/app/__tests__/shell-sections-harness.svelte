<script lang="ts">
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellLayoutController } from '../../workspace/admin-shell/layout-controller.svelte.js';
import ShellSectionMenu from '../../workspace/admin-shell/ShellSectionMenu.svelte';
import type { ShellNavGroup } from '../../workspace/admin-shell/types.js';
import AppShell from '../AppShell.svelte';
import Probe from './shell-layout-probe.svelte';

let {
  initial,
  currentHref = '/s/content',
  menuSection = 'content',
  collapsed = false,
  cards = false,
  onChange,
  onApi,
}: {
  initial?: ShellLayout | null;
  currentHref?: string;
  menuSection?: string;
  collapsed?: boolean;
  cards?: boolean;
  onChange?: (layout: ShellLayout) => void;
  onApi?: (api: ShellLayoutController) => void;
} = $props();

const navGroups: ShellNavGroup[] = [
  {
    id: 'content',
    heading: 'Content',
    icon: 'book',
    href: '/s/content',
    items: [
      {
        id: 'posts',
        href: '/posts',
        label: 'Posts',
        icon: 'fileText',
        description: 'Everything you publish.',
      },
      { id: 'pages', href: '/pages', label: 'Pages' },
      { id: 'media', href: '/media', label: 'Media' },
    ],
  },
  {
    id: 'people',
    heading: 'People',
    items: [{ id: 'users', href: '/users', label: 'Users' }],
  },
];

let current = $state<ShellLayout | null>(initial ?? null);
function change(next: ShellLayout) {
  current = next;
  onChange?.(next);
}
</script>

{#snippet meta(entry: { id: string })}<span data-testid={`meta-${entry.id}`}>3 records</span>{/snippet}
{#snippet actions(entry: { label: string })}<a href="/new">New {entry.label}</a>{/snippet}

<AppShell
  title="Test"
  {navGroups}
  edgeToggles={collapsed}
  navMode="sections"
  sectionHref={(id) => `/s/${id}`}
  {currentHref}
  config={{ left: { initial: collapsed ? 'collapsed' : 'expanded' } }}
  layoutEditing
  layout={current}
  onlayoutchange={change}
>
  {#if onApi}<Probe {onApi} />{/if}
  <ShellSectionMenu sectionId={menuSection} {meta} {actions} layout={cards ? 'cards' : 'list'} />
</AppShell>
