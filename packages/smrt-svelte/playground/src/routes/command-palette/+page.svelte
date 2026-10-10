<script lang="ts">
/**
 * Playground demo for the command palette and global search (#3713).
 *
 * The palette sits in the header center slot of an `AppShell` and opens from
 * the trigger or Ctrl/Cmd+K. Three providers feed it: the shell navigation,
 * model-driven providers derived from a hand-written manifest ("New invoice"
 * and a cross-model record search over a faked REST list route), and one
 * custom command provider. Try typing "inv", "acme", or "theme".
 */
import { AppShell } from '@happyvertical/smrt-svelte/app';
import {
  CommandPalette,
  createCommandPalette,
  createModelProviders,
  createNavigationProvider,
  type PaletteManifestLike,
} from '@happyvertical/smrt-svelte/command-palette';
import type { ShellNavGroup } from '@happyvertical/smrt-svelte/workspace';

const navGroups: ShellNavGroup[] = [
  {
    heading: 'Sales',
    items: [
      { href: '/invoices', label: 'Invoices', icon: 'receipt' },
      { href: '/customers', label: 'Customers', icon: 'users' },
    ],
  },
  { heading: 'Operations', items: [{ href: '/jobs', label: 'Jobs' }] },
];

const text = { type: 'text' } as const;
const manifest: PaletteManifestLike = {
  objects: {
    '@demo/sales:Invoice': {
      className: 'Invoice',
      qualifiedName: '@demo/sales:Invoice',
      collection: 'invoices',
      fields: {
        number: text,
        status: { type: 'text', enum: ['open', 'paid'] },
      },
      decoratorConfig: {},
    },
    '@demo/sales:Customer': {
      className: 'Customer',
      qualifiedName: '@demo/sales:Customer',
      collection: 'customers',
      fields: { name: text, email: text },
      decoratorConfig: {},
    },
  },
};

const rows: Record<string, Array<Record<string, string>>> = {
  invoices: [
    { id: 'i1', number: 'INV-1001' },
    { id: 'i2', number: 'INV-1002' },
  ],
  customers: [
    { id: 'c1', name: 'Acme Industries' },
    { id: 'c2', name: 'Acme Labs' },
    { id: 'c3', name: 'Globex' },
  ],
};

// A stand-in for the generated REST list route (`?field[like]=%term%`).
const fakeFetch: typeof fetch = async (input) => {
  const url = new URL(String(input), 'http://demo.local');
  const collection = url.pathname.split('/').pop() ?? '';
  const [key, value = ''] = [...url.searchParams.entries()][0] ?? [];
  const field = key?.replace(/\[like\]$/, '');
  const needle = value.replaceAll('%', '').toLowerCase();
  const matches = (rows[collection] ?? []).filter((row) =>
    row[field]?.toLowerCase().includes(needle),
  );
  return new Response(JSON.stringify(matches), {
    headers: { 'content-type': 'application/json' },
  });
};

let log = $state<string[]>([]);
const note = (message: string) => (log = [message, ...log].slice(0, 6));

const palette = createCommandPalette({
  navigate: (href) => note(`Navigate to ${href}`),
  providers: [
    createNavigationProvider({ groups: navGroups }),
    ...createModelProviders({ manifest, fetch: fakeFetch }),
    {
      id: 'demo.commands',
      label: 'Commands',
      order: 5,
      items: () => [
        {
          id: 'theme',
          title: 'Toggle theme',
          keywords: ['dark', 'light'],
          run: () => note('Toggled theme'),
        },
        {
          id: 'danger',
          title: 'Delete workspace',
          disabled: 'Requires the owner role',
        },
      ],
    },
  ],
});
</script>

{#snippet search()}
  <CommandPalette {palette} />
{/snippet}

<AppShell
  title="Palette demo"
  {navGroups}
  currentHref="/command-palette"
  config={{ left: { initial: 'expanded' } }}
  slotItems={[{ id: 'item:command-palette', label: 'Search', slot: 'header.center', render: search }]}
>
  <main>
    <p>Press Ctrl/Cmd+K, or use the search control in the header.</p>
    <h3>Last actions</h3>
    <ul>
      {#each log as entry}<li>{entry}</li>{/each}
    </ul>
  </main>
</AppShell>

<style>
  main { display: grid; gap: var(--smrt-spacing-4, 1rem); padding: var(--smrt-spacing-6, 1.5rem); max-inline-size: 60rem; }
</style>
