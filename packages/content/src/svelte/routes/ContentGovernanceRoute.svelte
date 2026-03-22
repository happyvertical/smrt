<script lang="ts">
import ContentGovernanceManager from '../components/ContentGovernanceManager.svelte';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
  getContentRouteHref,
} from './shared.js';

interface ContentGovernanceRouteProps {
  navigation?: ContentRouteNavigationItem[];
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
}: ContentGovernanceRouteProps = $props();

const workspaceHref = $derived(
  getContentRouteHref(navigation, CONTENT_ROUTE_IDS.workspace),
);
</script>

<div class="page">
  <header class="page-header">
    <div class="container">
      <div class="page-header__copy">
        <div class="eyebrow">Content governance</div>
        <h1>Governance Admin</h1>
        <p>
          Manage review policies, publication profiles, and assignment rules
          that the content workspace enforces during authoring and publication.
        </p>
      </div>

      <nav class="page-nav" aria-label="Content QA navigation">
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
      <strong>What this route covers</strong>
      <ul>
        <li>Create and edit governance policies, profiles, and type assignments.</li>
        <li>Confirm persisted overrides stay separate from package defaults.</li>
        <li>
          Return to the <a href={workspaceHref}>content workspace</a> to verify
          governed authoring and publication against the updated definitions.
        </li>
      </ul>
    </section>

    <section class="panel">
      <ContentGovernanceManager />
    </section>
  </main>
</div>

<style>
  :global(body) {
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
    letter-spacing: 0.08em;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .page-header h1 {
    margin: 0.35rem 0 0.65rem;
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }

  .page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 1rem;
    max-width: 42rem;
  }

  .page-nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .page-nav a {
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: 600;
    opacity: 0.85;
  }

  .page-nav a[aria-current='page'] {
    opacity: 1;
    color: var(--smrt-color-primary);
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
