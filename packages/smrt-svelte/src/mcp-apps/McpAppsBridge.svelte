<!--
  @component
  Shipped portable MCP Apps view shell. Owns one mount-scoped host bridge
  (`useMcpApp`), renders the app's own content, and offers a portable
  display-mode request only when the bound host advertises that mode. Any
  host failure or missing capability keeps the view inline with a status
  message; the view never requires host controls. Browser-only: imports no
  server code, credentials, or OpenAI-specific helpers.
-->
<script lang="ts">
import type { DisplayMode } from '@happyvertical/smrt-mcp-apps';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { type McpAppState, useMcpApp } from './mcp-apps.svelte.js';
import { M } from './strings.js';

interface McpAppsBridgeProps {
  /** Exact, application-configured host origin. Never derive this from URL input. */
  hostOrigin: string;
  /** View identity sent in `ui/initialize`. */
  appInfo: { name: string; version: string };
  /** Visible view heading, already localized by the application. */
  title: string;
  /** Optional lead text, already localized by the application. */
  description?: string;
  /** Modes this view supports. Defaults to `['inline', 'fullscreen']`. */
  availableDisplayModes?: DisplayMode[];
  /** Mode offered by the expand control. Defaults to `'fullscreen'`. */
  expandMode?: Exclude<DisplayMode, 'inline'>;
  /** Host window override for tests. Defaults to the immediate parent. */
  hostWindow?: () => Window;
  /** Request timeout in milliseconds (1–120000). */
  timeoutMs?: number;
  /** App content; receives the bridge state for capability-gated calls. */
  children?: Snippet<[McpAppState]>;
}

let {
  hostOrigin,
  appInfo,
  title,
  description,
  availableDisplayModes = ['inline', 'fullscreen'],
  expandMode = 'fullscreen',
  hostWindow,
  timeoutMs,
  children,
}: McpAppsBridgeProps = $props();

const { t } = useI18n();
const headingId = $props.id();
let requestFailed = $state(false);
let requesting = $state(false);

// Options are read once, at mount, in the browser; SSR constructs nothing.
const app = useMcpApp(() => ({
  appInfo: { ...appInfo },
  availableDisplayModes: [...availableDisplayModes],
  hostOrigin,
  hostWindow: hostWindow ? hostWindow() : window.parent,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
}));

const ready = $derived(app.snapshot?.state === 'ready');
const canExpand = $derived(
  ready &&
    !app.error &&
    !requestFailed &&
    availableDisplayModes.includes(expandMode) &&
    (app.snapshot?.hostContext.availableDisplayModes ?? ['inline']).includes(
      expandMode,
    ) &&
    app.snapshot?.hostContext.displayMode !== expandMode,
);
const inlineOnly = $derived(
  Boolean(app.error) ||
    requestFailed ||
    (ready &&
      !(app.snapshot?.hostContext.availableDisplayModes ?? ['inline']).includes(
        expandMode,
      )),
);

async function expand() {
  const bridge = app.bridge;
  if (!bridge || requesting) return;
  requesting = true;
  try {
    await bridge.requestDisplayMode(expandMode);
  } catch {
    requestFailed = true;
  } finally {
    requesting = false;
  }
}
</script>

<section aria-labelledby={headingId} class="smrt-mcp-apps-bridge">
  <h1 id={headingId}>{title}</h1>
  {#if description}<p>{description}</p>{/if}
  {#if inlineOnly}
    <p role="status">{t(M['ui.mcp_apps.inline_only'])}</p>
  {:else if canExpand}
    <Button type="button" onclick={expand} loading={requesting}>
      {t(M['ui.mcp_apps.expand'])}
    </Button>
  {:else if !ready}
    <p role="status" class="smrt-mcp-apps-bridge__pending">
      {t(M['ui.mcp_apps.connecting'])}
    </p>
  {/if}
  {@render children?.(app)}
</section>

<style>
.smrt-mcp-apps-bridge {
  display: grid;
  gap: var(--smrt-space-3, 0.75rem);
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
