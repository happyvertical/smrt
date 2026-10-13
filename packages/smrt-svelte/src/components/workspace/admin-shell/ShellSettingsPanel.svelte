<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import {
  ColorSchemeToggle,
  ThemeSwitcher,
} from '@happyvertical/smrt-ui/themes';
import { Button } from '@happyvertical/smrt-ui/ui';
import { useAuth } from '../../../hooks/useAuth.svelte.js';
import { M } from '../../../i18n/strings.workspace.js';
import { useAdminShell } from './context.js';
import HotkeyInput from './HotkeyInput.svelte';
import { tryUseShellLayout } from './layout-context.js';
import { resolveHotkey } from './settings.js';
import { SHELL_REGION_MESSAGES } from './slot-labels.js';
import type { ShellRegion } from './slots.js';
import type { PanelEdge, ShellHotkeyBinding } from './types.js';

interface Props {
  /** Show the Appearance section (needs a `ThemeProvider` above). */
  appearance?: boolean;
  /** Show the Account section (needs the Provider's `useAuth()` above). */
  account?: boolean;
  /** Where the sign-out control goes; the control is hidden when neither this nor `onSignOut` is given. */
  signOutHref?: string;
  /**
   * Called by the sign-out control instead of following `signOutHref`. May
   * return a promise: the control is busy and disabled while it is pending;
   * a rejection shows an inline error and leaves the section as it was.
   */
  onSignOut?: () => void | Promise<void>;
}

const {
  appearance = false,
  account = false,
  signOutHref,
  onSignOut,
}: Props = $props();

const { t } = useI18n();
const shell = useAdminShell();
const layout = tryUseShellLayout();
const auth = account ? useAuth() : null;
const edges: PanelEdge[] = ['top', 'left', 'bottom', 'right'];
/** The identity `User` carries no display name; hosts may attach one (e.g. from the profile). */
const accountName = $derived.by(() => {
  const name = (auth?.user as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name ? name : null;
});
const REGION_OF_EDGE: Record<PanelEdge, ShellRegion> = {
  top: 'header',
  bottom: 'footer',
  left: 'leftSidebar',
  right: 'rightSidebar',
};
const regionLabel = (edge: PanelEdge) =>
  t(SHELL_REGION_MESSAGES[REGION_OF_EDGE[edge]]);

/**
 * The areas this shell offers. A region the user hid stays listed so Show can
 * restore it; a region that is shown but not rendered (nothing to put in it, or
 * not presented at this width) is left out because its row would do nothing.
 */
const rows = $derived(
  layout
    ? layout.panels
        .filter(
          (panel) =>
            panel.available &&
            (!panel.visible || shell.regionsRendered[panel.edge]),
        )
        .map((panel) => ({ edge: panel.edge, visible: panel.visible }))
    : edges
        .filter(
          (edge) =>
            shell.panels[edge] !== 'hidden' && shell.regionsRendered[edge],
        )
        .map((edge) => ({ edge, visible: true })),
);
/** Counts every shown region, rendered or not, so the last real one can't be hidden. */
const visibleCount = $derived(
  layout
    ? layout.panels.filter((panel) => panel.available && panel.visible).length
    : rows.length,
);
const shortcutRows = $derived(rows.filter((row) => row.visible));
let signingOut = $state(false);
let signOutFailed = $state(false);

async function runSignOut() {
  if (signingOut || !onSignOut) return;
  signingOut = true;
  signOutFailed = false;
  try {
    await onSignOut();
  } catch {
    signOutFailed = true;
  } finally {
    signingOut = false;
  }
}
const canSignOut = $derived(Boolean(signOutHref || onSignOut));
const hotkeysEnabled = $derived(shell.settings.hotkeysEnabled !== false);

function bindingFor(edge: PanelEdge): ShellHotkeyBinding | null {
  return resolveHotkey(edge, shell.config.panels[edge], shell.settings);
}

function conflictFor(edge: PanelEdge): string | null {
  const binding = bindingFor(edge);
  if (!binding) return null;
  const conflict = edges.find(
    (candidate) =>
      candidate !== edge &&
      bindingFor(candidate)?.code === binding.code &&
      bindingFor(candidate)?.altKey === binding.altKey &&
      bindingFor(candidate)?.ctrlKey === binding.ctrlKey &&
      bindingFor(candidate)?.metaKey === binding.metaKey &&
      bindingFor(candidate)?.shiftKey === binding.shiftKey,
  );
  return conflict ? shell.config.panels[conflict].label : null;
}
</script>

<section
  class="smrt-shell-settings-panel"
  aria-label={t(M['ui.shell_settings_panel.shell_settings'])} data-smrt-component="ShellSettingsPanel"
>
  {#if appearance}
    <section data-smrt-part="appearance" aria-labelledby="smrt-shell-settings-appearance">
      <h3 id="smrt-shell-settings-appearance">{t(M['ui.shell_settings.appearance'])}</h3>
      <div class="smrt-shell-settings-panel__controls">
        <ThemeSwitcher label={t(M['ui.shell_settings.theme'])} />
        <ColorSchemeToggle ariaLabel={t(M['ui.shell_settings.color_scheme'])} />
      </div>
    </section>
  {/if}

  {#if auth}
    <section data-smrt-part="account" aria-labelledby="smrt-shell-settings-account">
      <h3 id="smrt-shell-settings-account">{t(M['ui.shell_settings.account'])}</h3>
      {#if auth.user}
        <dl>
          {#if accountName}
            <dt>{t(M['ui.shell_settings.account_name'])}</dt>
            <dd>{accountName}</dd>
          {/if}
          <dt>{t(M['ui.shell_settings.account_email'])}</dt>
          <dd>{auth.user.email}</dd>
        </dl>
      {:else}
        <p>{t(M['ui.shell_settings.account_signed_out'])}</p>
      {/if}
      {#if canSignOut}
        {#if onSignOut}
          <Button
            variant="secondary"
            size="sm"
            loading={signingOut}
            onclick={runSignOut}
          >
            {t(M['ui.shell_settings.sign_out'])}
          </Button>
          {#if signOutFailed}
            <p role="alert" data-smrt-part="error">
              {t(M['ui.shell_settings.sign_out_failed'])}
            </p>
          {/if}
        {:else}
          <Button variant="secondary" size="sm" href={signOutHref}>
            {t(M['ui.shell_settings.sign_out'])}
          </Button>
        {/if}
      {/if}
    </section>
  {/if}

  <section data-smrt-part="layout" aria-labelledby="smrt-shell-settings-layout">
    <h3 id="smrt-shell-settings-layout">{t(M['ui.shell_settings.layout'])}</h3>
    <p>{t(M['ui.shell_settings_panel.description'])}</p>
    {#if layout?.editable}
      <div class="smrt-shell-settings-panel__controls">
        <Button
          variant={layout.editing ? 'primary' : 'secondary'}
          size="sm"
          aria-pressed={layout.editing}
          onclick={() => layout.setEditing(!layout.editing)}
        >
          {layout.editing
            ? t(M['ui.shell_settings.edit_layout_on'])
            : t(M['ui.shell_settings.edit_layout_off'])}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!layout.customized}
          onclick={() => layout.reset()}
        >
          {t(M['ui.shell_settings.reset_layout'])}
        </Button>
      </div>
    {:else if layout}
      <div class="smrt-shell-settings-panel__controls">
        <Button
          variant="ghost"
          size="sm"
          disabled={!layout.customized}
          onclick={() => layout.reset()}
        >
          {t(M['ui.shell_settings.reset_layout'])}
        </Button>
      </div>
    {/if}
    <div class="smrt-shell-settings-panel__grid">
      {#each rows as row (row.edge)}
        {@const label = regionLabel(row.edge)}
        <div class="smrt-shell-settings-panel__row" data-edge={row.edge}>
          <div>
            <strong>{label}</strong>
            <span>
              {row.visible
                ? t(M['ui.shell_settings.region_shown'])
                : t(M['ui.shell_settings.region_hidden'])}
            </span>
          </div>
          <div class="smrt-shell-settings-panel__actions">
            {#if layout}
              <Button
                variant="ghost"
                size="sm"
                disabled={row.visible && visibleCount <= 1}
                aria-label={row.visible
                  ? t(M['ui.shell_settings.hide_region'], { region: label })
                  : t(M['ui.shell_settings.show_region'], { region: label })}
                onclick={() =>
                  layout.setPanel(row.edge, { visible: !row.visible })}
              >
                {row.visible
                  ? t(M['ui.shell_settings.hide'])
                  : t(M['ui.shell_settings.show'])}
              </Button>
            {/if}
            {#if row.visible && !shell.isInline(row.edge)}
              <Button
                variant="ghost"
                size="sm"
                onclick={() =>
                  shell.setPanel(
                    row.edge,
                    shell.panels[row.edge] === 'expanded'
                      ? 'collapsed'
                      : 'expanded',
                  )}
              >
                {shell.panels[row.edge] === 'expanded'
                  ? t(M['ui.shell_settings_panel.collapse'])
                  : t(M['ui.shell_settings_panel.expand'])}
              </Button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>

  {#if shell.hotkeysAvailable}
    <section data-smrt-part="shortcuts" aria-labelledby="smrt-shell-settings-shortcuts">
      <header>
        <h3 id="smrt-shell-settings-shortcuts">{t(M['ui.shell_settings.shortcuts'])}</h3>
        <Button
          variant={hotkeysEnabled ? 'secondary' : 'primary'}
          size="sm"
          onclick={() => shell.setHotkeysEnabled(!hotkeysEnabled)}
        >
          {hotkeysEnabled
            ? t(M['ui.shell_settings_panel.disable_hotkeys'])
            : t(M['ui.shell_settings_panel.enable_hotkeys'])}
        </Button>
      </header>
      <div class="smrt-shell-settings-panel__grid">
        {#each shortcutRows as row (row.edge)}
          <div class="smrt-shell-settings-panel__row" data-edge={row.edge}>
            <strong>{regionLabel(row.edge)}</strong>
            <HotkeyInput
              value={bindingFor(row.edge)}
              disabled={!hotkeysEnabled}
              conflictsWith={conflictFor(row.edge)}
              oncapture={(binding) =>
                shell.setHotkey(row.edge, binding?.code ?? null)}
            />
          </div>
        {/each}
      </div>
    </section>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-shell-settings-panel {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-inline-size: 0;
    overflow-wrap: anywhere;
    gap: var(--smrt-spacing-4);
  }

  .smrt-shell-settings-panel header,
  .smrt-shell-settings-panel__row,
  .smrt-shell-settings-panel__actions {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3);
  }

  .smrt-shell-settings-panel header,
  .smrt-shell-settings-panel__row {
    justify-content: space-between;
  }

  .smrt-shell-settings-panel h3,
  .smrt-shell-settings-panel p,
  .smrt-shell-settings-panel dl,
  .smrt-shell-settings-panel dd {
    margin: 0;
  }

  .smrt-shell-settings-panel > section {
    display: grid;
    gap: var(--smrt-spacing-3);
    justify-items: start;
  }

  .smrt-shell-settings-panel > section > .smrt-shell-settings-panel__grid,
  .smrt-shell-settings-panel > section > header {
    justify-self: stretch;
  }

  .smrt-shell-settings-panel__controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-3);
  }

  .smrt-shell-settings-panel dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--smrt-spacing-1) var(--smrt-spacing-4);
  }

  .smrt-shell-settings-panel p,
  .smrt-shell-settings-panel span {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-shell-settings-panel__grid {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .smrt-shell-settings-panel__row {
    padding-block: var(--smrt-spacing-3);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-shell-settings-panel__row > div:first-child {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  @media (max-width: 42rem) {
    .smrt-shell-settings-panel header,
    .smrt-shell-settings-panel__row,
    .smrt-shell-settings-panel__actions {
      align-items: stretch;
      flex-direction: column;
    }
  }
}
</style>
