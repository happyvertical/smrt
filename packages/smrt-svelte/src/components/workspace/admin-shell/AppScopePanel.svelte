<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import ShellSettingsPanel from './ShellSettingsPanel.svelte';

interface Props {
  /** Application name displayed at the top of the panel. */
  appName: string;
  /** Current tenant name shown below the app name. */
  tenantName?: string;
  /** Environment badge text (staging, production, etc). */
  environment?: string;
  /** Custom search content section. */
  search?: Snippet;
  /** Custom documentation content section. */
  docs?: Snippet;
  /** Custom switcher content section. */
  switcher?: Snippet;
  /** Show or hide the settings panel. */
  showSettings?: boolean;
}

let {
  appName,
  tenantName = '',
  environment = '',
  search,
  docs,
  switcher,
  showSettings = true,
}: Props = $props();
const { t } = useI18n();
</script>

<section
  class="smrt-app-scope-panel"
  aria-label={t(M['ui.app_scope_panel.app_scope'])}
>
  <header>
    <div>
      <h2>{appName}</h2>
      {#if tenantName}
        <p>{tenantName}</p>
      {/if}
    </div>
    {#if environment}
      <Badge variant="info" size="sm">{environment}</Badge>
    {/if}
  </header>

  {#if switcher}
    <div class="smrt-app-scope-panel__section">
      {@render switcher()}
    </div>
  {/if}

  {#if search}
    <div class="smrt-app-scope-panel__section">
      {@render search()}
    </div>
  {/if}

  {#if docs}
    <div class="smrt-app-scope-panel__section">
      {@render docs()}
    </div>
  {/if}

  {#if showSettings}
    <ShellSettingsPanel />
  {/if}
</section>

<style>
  .smrt-app-scope-panel {
    display: grid;
    gap: var(--smrt-spacing-5);
  }

  .smrt-app-scope-panel header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .smrt-app-scope-panel h2,
  .smrt-app-scope-panel p {
    margin: 0;
  }

  .smrt-app-scope-panel p {
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-app-scope-panel__section {
    min-width: 0;
  }
</style>
