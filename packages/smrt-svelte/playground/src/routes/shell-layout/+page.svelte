<script lang="ts">
/**
 * Playground demo for user-customizable shell layout (#3603).
 *
 * The host owns persistence: it keeps the `ShellLayout` in its own state (here
 * a plain variable, in a real app a database row or an exportable blueprint
 * document) and feeds it back through `layout`. Try hiding a panel, dragging
 * items between sections, rename a section, hide its title, create your own
 * section and drag items into it, or focusing a move handle and pressing Space then
 * the arrow keys. Press the pencil ("Edit layout") in the header to edit the
 * real shell in place: every slot becomes a dashed drop zone, items and nav
 * rows get grips, section headings get eye / heading icons and a floating
 * toolbar (hover or click) with rename, delete and the host's Options and Help
 * actions (`sectionActions`). Hidden regions show as strips with a show button.
 * "Import" shows an untrusted JSON layout being normalized.
 */
import { AppShell, ShellLayoutEditor } from '@happyvertical/smrt-svelte/app';
import {
  normalizeShellLayout,
  ShellIconButton,
  type ShellLayout,
  type ShellNavGroup,
  type ShellNavItem,
} from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui/ui';

const nav: ShellNavItem[] = [{ href: '/', label: 'Home' }];
const navGroups: ShellNavGroup[] = [
  {
    heading: 'Content',
    items: [
      { href: '/posts', label: 'Posts' },
      { href: '/pages', label: 'Pages' },
      { href: '/media', label: 'Media' },
    ],
  },
  {
    heading: 'People',
    items: [
      { href: '/users', label: 'Users' },
      { href: '/roles', label: 'Roles' },
    ],
  },
  { heading: 'Operations', items: [{ href: '/jobs', label: 'Jobs' }] },
];

let layout = $state<ShellLayout | null>(null);
let draft = $state('');

function importDraft(): void {
  try {
    layout = normalizeShellLayout(JSON.parse(draft));
  } catch {
    layout = null;
  }
}
</script>

{#snippet clock()}<span>12:00</span>{/snippet}
{#snippet sectionActions({ label }: { label: string })}
  <ShellIconButton icon="more" label={`Options for ${label}`} />
{/snippet}

<AppShell
  title="Layout demo"
  dockToggles={[
    { tool: 'assistant', label: 'Assistant' },
    { tool: 'notes', label: 'Notes', icon: 'N' },
  ]}
  slotItems={[{ id: 'demo:clock', label: 'Clock', slot: 'footer.end', render: clock }]}
  layoutEditing
  {sectionActions}
  {nav}
  {navGroups}
  currentHref="/shell-layout"
  config={{ left: { initial: 'expanded' } }}
  {layout}
  onlayoutchange={(next) => (layout = next)}
>
  <main>
    <ShellLayoutEditor />
    <section>
      <h3>Stored layout</h3>
      <pre>{JSON.stringify(layout ?? { version: 1 }, null, 2)}</pre>
      <label>
        Import a layout (JSON)
        <textarea rows="4" bind:value={draft}></textarea>
      </label>
      <Button size="sm" onclick={importDraft}>Import</Button>
    </section>
  </main>
</AppShell>

<style>
  main { display: grid; gap: var(--smrt-spacing-6, 1.5rem); padding: var(--smrt-spacing-6, 1.5rem); max-inline-size: 60rem; }
  pre { overflow: auto; padding: var(--smrt-spacing-3, 0.75rem); background: var(--smrt-color-surface-container, #eee); border-radius: var(--smrt-radius-md, 6px); }
  label { display: grid; gap: var(--smrt-spacing-1, 0.25rem); }
</style>
