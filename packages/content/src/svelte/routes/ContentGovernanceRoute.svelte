<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import ContentGovernanceManager from '../components/ContentGovernanceManager.svelte';
import type { ContentGovernanceManagerClient } from '../governance-manager-client.js';
import { M } from '../i18n.routes.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
  getContentRouteHref,
} from './shared.js';

interface ContentGovernanceRouteProps {
  /** Pre-initialized governance client; creates a new one if omitted. */
  client?: ContentGovernanceManagerClient;
  /** Navigation items shown in the sidebar. */
  navigation?: ContentRouteNavigationItem[];
  /** Base URL for governance API requests. */
  apiBaseUrl?: string;
  /** Whether the route is embedded in a parent application. */
  embedded?: boolean;
}

let {
  client = undefined,
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  embedded = false,
}: ContentGovernanceRouteProps = $props();

const workspaceHref = $derived(
  getContentRouteHref(navigation, CONTENT_ROUTE_IDS.workspace),
);
const { t } = useI18n();
</script>

<div class="smrt-content-governance-route__root" class:smrt-content-governance-route__root--embedded={embedded} data-smrt-component="ContentGovernanceRoute">
  <header class="smrt-content-governance-route__header" data-smrt-part="header">
    <div class="smrt-content-governance-route__container" data-smrt-part="row">
      <div class="smrt-content-governance-route__copy" data-smrt-part="body">
        <div class="smrt-content-governance-route__eyebrow" data-smrt-part="label">{t(M['content.governance.eyebrow'])}</div>
        <h1>{t(M['content.governance.heading'])}</h1>
        <p>
          {t(M['content.governance.intro'])}
        </p>
      </div>

      <nav class="smrt-content-governance-route__nav" data-smrt-part="nav" aria-label={t(M['content.governance.nav_aria'])}>
        {#each navigation as item (item.routeId)}
          <a
            href={item.href}
            aria-current={item.routeId === CONTENT_ROUTE_IDS.governance
              ? 'page'
              : undefined}
          >
            {item.label}
          </a>
        {/each}
      </nav>
    </div>
  </header>

  <main class="smrt-content-governance-route__container smrt-content-governance-route__main" data-smrt-part="body">
    <section class="smrt-content-governance-route__callout" data-smrt-part="status">
      <strong>{t(M['content.governance.controls_title'])}</strong>
      <ul>
        <li>{t(M['content.governance.controls_policies'])}</li>
        <li>{t(M['content.governance.controls_types'])}</li>
        <li>
          {t(M['content.governance.controls_return_prefix'])} <a href={workspaceHref}>{t(M['content.governance.controls_workspace_link'])}</a> {t(M['content.governance.controls_return_suffix'])}
        </li>
      </ul>
    </section>

    <section class="smrt-content-governance-route__panel" data-smrt-part="panel">
      <ContentGovernanceManager {apiBaseUrl} {client} />
    </section>
  </main>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body:has(.smrt-content-governance-route__root:not(.smrt-content-governance-route__root--embedded))) {
    margin: 0;
    min-height: 100vh;
  }
  .smrt-content-governance-route__root {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }
  .smrt-content-governance-route__root--embedded {
    min-height: auto;
    padding: 0;
  }
  .smrt-content-governance-route__container {
    max-width: 1280px;
    margin: 0 auto;
  }
  .smrt-content-governance-route__header {
    margin-bottom: 1.5rem;
  }
  .smrt-content-governance-route__header .smrt-content-governance-route__container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-governance-route__copy {
    max-width: 48rem;
  }
  .smrt-content-governance-route__header h1 {
    margin: 0.35rem 0 0.65rem;
  }
  .smrt-content-governance-route__header p {
    margin: 0;
    max-width: 42rem;
  }
  .smrt-content-governance-route__nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .smrt-content-governance-route__nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
  }
  .smrt-content-governance-route__main {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-governance-route__callout,
  .smrt-content-governance-route__panel {
    padding: 1.25rem;
  }
  .smrt-content-governance-route__callout {
    display: grid;
    gap: 0.75rem;
  }
  .smrt-content-governance-route__callout ul {
    margin: 0;
    padding-left: 1.25rem;
  }
}

@layer smrt.theme {
  :global(body:has(.smrt-content-governance-route__root:not(.smrt-content-governance-route__root--embedded))) {
    font-family:
      var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont,
      'Segoe UI', Roboto, sans-serif);
    background:
      radial-gradient(
        circle at top,
        color-mix(in srgb, var(--smrt-color-primary) 10%, transparent),
        transparent 36%
      ),
      var(--smrt-color-background);
    color: var(--smrt-color-on-background);
  }
  .smrt-content-governance-route__eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-governance-route__header h1 {
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }
  .smrt-content-governance-route__header p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-content-governance-route__nav a {
    border-radius: var(--smrt-radius-full);
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-governance-route__nav a[aria-current='page'] {
    color: var(--smrt-color-primary);
    border-color: color-mix(
      in srgb,
      var(--smrt-color-primary) 28%,
      transparent
    );
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 10%,
      var(--smrt-color-surface)
    );
  }
  .smrt-content-governance-route__callout,
  .smrt-content-governance-route__panel {
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
  }
  .smrt-content-governance-route__callout strong {
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-governance-route__callout ul {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-governance-route__callout a {
    color: var(--smrt-color-primary);
  }
}

</style>
