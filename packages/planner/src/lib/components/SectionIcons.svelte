<script lang="ts">
// Icon paths are Material Design Icons "help" and "settings" (Apache-2.0,
// https://github.com/google/material-design-icons). smrt-ui's Icon fills its
// path, so a filled set is used rather than stroked Lucide paths.
import { Icon } from '@happyvertical/smrt-ui';
import { appHref } from '$lib/planner/app.svelte.ts';

const HELP =
  'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z';
const SETTINGS =
  'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z';

interface SectionIconsProps {
  /** The section id (`/recipes/<id>/`), see `recipes/sections.ts`. */
  section: string;
  /** The section's label, for the accessible names: "Products help". */
  label: string;
  /** The icon whose page this is; it gets `aria-current="page"`. */
  current?: 'help' | 'options';
  /** A fragment on the Help page, e.g. the current model's fields. */
  helpAnchor?: string;
}

let { section, label, current, helpAnchor }: SectionIconsProps = $props();

const helpHref = $derived(
  `${appHref(`/recipes/${section}/help/`)}${helpAnchor ? `#${helpAnchor}` : ''}`,
);
</script>

<div class="icons">
  <a
    href={helpHref}
    title={`${label} help`}
    aria-label={`${label} help`}
    aria-current={current === 'help' ? 'page' : undefined}
  >
    <Icon path={HELP} size={22} />
  </a>
  <a
    href={appHref(`/recipes/${section}/`)}
    title={`${label} options`}
    aria-label={`${label} options`}
    aria-current={current === 'options' ? 'page' : undefined}
  >
    <Icon path={SETTINGS} size={22} />
  </a>
</div>

<style>
  .icons {
    display: flex;
    gap: var(--smrt-spacing-1);
    margin-inline-start: auto;
  }

  a {
    display: inline-grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 50%;
    color: var(--smrt-color-on-surface-variant);
  }

  a:hover {
    background: var(--smrt-color-surface-container-high, rgb(0 0 0 / 8%));
    color: var(--smrt-color-on-surface);
  }

  a:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }

  a[aria-current='page'] {
    background: var(--smrt-color-secondary-container, rgb(0 0 0 / 12%));
    color: var(--smrt-color-primary);
  }
</style>
