<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import ContentGovernanceManager from '../components/ContentGovernanceManager.svelte';
import { M } from '../i18n.routes.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
  getContentRouteHref,
} from './shared.js';

interface ContentGovernanceRouteProps {
  navigation?: ContentRouteNavigationItem[];
  apiBaseUrl?: string;
  embedded?: boolean;
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  embedded = false,
}: ContentGovernanceRouteProps = $props();

const workspaceHref = $derived(
  getContentRouteHref(navigation, CONTENT_ROUTE_IDS.workspace),
);
const { t } = useI18n();
</script>

<div class:page={true} class:page--embedded={embedded}>
  <header class="page-header">
    <div class="container">
      <div class="page-header__copy">
        <div class="eyebrow">{t(M['content.governance.eyebrow'])}</div>
        <h1>{t(M['content.governance.heading'])}</h1>
        <p>
          {t(M['content.governance.intro'])}
        </p>
      </div>

      <nav class="page-nav" aria-label={t(M['content.governance.nav_aria'])}>
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

  <main class="container page-main">
    <section class="callout">
      <strong>{t(M['content.governance.controls_title'])}</strong>
      <ul>
        <li>{t(M['content.governance.controls_policies'])}</li>
        <li>{t(M['content.governance.controls_types'])}</li>
        <li>
          {t(M['content.governance.controls_return_prefix'])} <a href={workspaceHref}>{t(M['content.governance.controls_workspace_link'])}</a> {t(M['content.governance.controls_return_suffix'])}
        </li>
      </ul>
    </section>

    <section class="panel">
      <ContentGovernanceManager {apiBaseUrl} />
    </section>
  </main>
</div>

<style>
  :global(body:has(.page:not(.page--embedded))) {
    margin: 0;
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
    min-height: 100vh;
  }

  .page {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }

  .page--embedded {
    min-height: auto;
    padding: 0;
  }

  .container {
    max-width: 1280px;
    margin: 0 auto;
  }

  .page-header {
    margin-bottom: 1.5rem;
  }

  .page-header .container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .page-header__copy {
    max-width: 48rem;
  }

  .eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .page-header h1 {
    margin: 0.35rem 0 0.65rem;
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }

  .page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    max-width: 42rem;
  }

  .page-nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .page-nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .page-nav a[aria-current='page'] {
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

  .page-main {
    display: grid;
    gap: 1rem;
  }

  .callout,
  .panel {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
    padding: 1.25rem;
  }

  .callout {
    display: grid;
    gap: 0.75rem;
  }

  .callout strong {
    color: var(--smrt-color-on-surface);
  }

  .callout ul {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .callout a {
    color: var(--smrt-color-primary);
  }
</style>
