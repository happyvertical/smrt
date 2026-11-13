<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.workspace.js';
import { useAdminShell } from '../workspace/admin-shell/context.js';
import ShellSettingsPanel from '../workspace/admin-shell/ShellSettingsPanel.svelte';
import {
  isShellSettingsSection,
  SHELL_SETTINGS_SECTIONS,
  type ShellSettingsSection,
} from '../workspace/admin-shell/settings-sections.js';
import type { ShellSettingsMenuItem } from './settings-menu-item.js';

interface Props {
  /**
   * Where the Account section's sign-out link goes; shown only when given. A
   * link is a GET: never point it at the runtime's POST-only `/sign-out`; use
   * `onSignOut` for that.
   */
  signOutHref?: string;
  /** Called by the sign-out control instead of following `signOutHref`; may be async (busy while pending, inline error on rejection). */
  onSignOut?: () => unknown;
  /**
   * Turns on the section menu: the settings route (e.g. `/settings`). Without
   * a `section` the page lists the sections, each linking to
   * `${basePath}/${id}`; with one it renders only that section and links back.
   * Omit for the one-page mode that shows every section.
   */
  basePath?: string;
  /** Built-in section to render on its own page (needs `basePath` for the back link). */
  section?: ShellSettingsSection;
  /** Host sections listed after the built-in ones in the menu. */
  extraSections?: ShellSettingsMenuItem[];
  /** Heading of a host section page (`children` without a built-in `section`). */
  title?: string;
  /** Host section content, rendered instead of the built-in panel. */
  children?: Snippet;
}

const {
  signOutHref,
  onSignOut,
  basePath,
  section,
  extraSections = [],
  title,
  children,
}: Props = $props();
const { t } = useI18n();
const shell = useAdminShell();

const labels: Record<ShellSettingsSection, string> = $derived({
  appearance: t(M['ui.shell_settings.appearance']),
  account: t(M['ui.shell_settings.account']),
  layout: t(M['ui.shell_settings.layout']),
  shortcuts: t(M['ui.shell_settings.shortcuts']),
});
const descriptions: Record<ShellSettingsSection, string> = $derived({
  appearance: t(M['ui.shell_settings_page.appearance_description']),
  account: t(M['ui.shell_settings_page.account_description']),
  layout: t(M['ui.shell_settings_page.layout_description']),
  shortcuts: t(M['ui.shell_settings_page.shortcuts_description']),
});
const menu: ShellSettingsMenuItem[] = $derived([
  ...SHELL_SETTINGS_SECTIONS.filter(
    (id) => id !== 'shortcuts' || shell.hotkeysAvailable,
  ).map((id) => ({
    id: id as string,
    label: labels[id],
    description: descriptions[id],
  })),
  ...extraSections,
]);
const builtIn = $derived(isShellSettingsSection(section) ? section : undefined);
const sectioned = $derived(Boolean(basePath));
const showMenu = $derived(sectioned && !builtIn && !children);
const heading = $derived(
  builtIn ? labels[builtIn] : (title ?? t(M['ui.shell_settings_page.heading'])),
);
</script>

<section class="smrt-shell-settings-page" data-smrt-component="ShellSettingsPage">
  <header>
    {#if sectioned && !showMenu}
      <a class="smrt-shell-settings-page__back" href={basePath} data-smrt-part="back">
        {t(M['ui.shell_settings_page.back'])}
      </a>
    {/if}
    <h1>{showMenu ? t(M['ui.shell_settings_page.heading']) : heading}</h1>
    {#if showMenu || !sectioned}
      <p>{t(M['ui.shell_settings_page.description'])}</p>
    {/if}
  </header>
  {#if showMenu}
    <nav aria-label={t(M['ui.shell_settings_page.menu_label'])} data-smrt-part="menu">
      <ul>
        {#each menu as item (item.id)}
          <li>
            <a href={`${basePath}/${item.id}`} data-section={item.id}>
              <strong>{item.label}</strong>
              {#if item.description}<span>{item.description}</span>{/if}
            </a>
          </li>
        {/each}
      </ul>
    </nav>
  {:else if children}
    {@render children()}
  {:else if builtIn}
    <ShellSettingsPanel section={builtIn} {signOutHref} {onSignOut} />
  {:else}
    <ShellSettingsPanel appearance account {signOutHref} {onSignOut} />
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-shell-settings-page {
    display: grid;
    gap: var(--smrt-spacing-6, 1.5rem);
    max-width: 720px;
    padding: var(--smrt-spacing-8, 2rem);
  }
  header {
    display: grid;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  h1,
  p {
    margin: 0;
  }
  .smrt-shell-settings-page__back {
    justify-self: start;
  }
  ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li a {
    display: grid;
    gap: var(--smrt-spacing-1, 0.25rem);
    padding-block: var(--smrt-spacing-3, 0.75rem);
  }
}

@layer smrt.theme {
  .smrt-shell-settings-page__back {
    color: var(--smrt-color-on-surface-variant);
  }
  li a {
    border-block-start: var(--smrt-hairline);
    color: inherit;
    text-decoration: none;
  }
  li a span {
    color: var(--smrt-color-on-surface-variant);
  }
  li a:hover strong {
    text-decoration: underline;
  }
}
</style>
