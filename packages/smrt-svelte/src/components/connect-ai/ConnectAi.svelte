<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import { onMount, untrack } from 'svelte';
import { M } from '../../i18n/strings.connect-ai.js';
import { safeHref } from '../overview/markdown.js';
import type { ConnectAiClient, ConnectAiState } from './types.js';

interface Props {
  /** Authenticated transport, usually createConnectAiClient. No provider clients in the browser. */
  client: ConnectAiClient;
  /** Host's existing inference settings/key form, shared with advanced settings. */
  apiKeyHref: string;
  /** Onboarding and settings share exactly the same engine policy. */
  variant?: 'onboarding' | 'settings';
  /** Optional server-loaded snapshot, refreshed on mount and browser focus. */
  initialState?: ConnectAiState;
  /** Reports readiness so an onboarding host can enable its next step. */
  onchange?: (state: ConnectAiState, ready: boolean) => void;
  /** Sign-in polling interval; defaults to 2.5 seconds. */
  pollMs?: number;
}

let {
  client,
  apiKeyHref,
  variant = 'onboarding',
  initialState,
  onchange,
  pollMs = 2500,
}: Props = $props();
const { t } = useI18n();
let info = $state<ConnectAiState | undefined>(untrack(() => initialState));
let busy = $state(false);
let failed = $state(false);
let signInUrl = $state<string | undefined>();
let stopped = false;
let refreshing: Promise<void> | undefined;
const active = new AbortController();
const titleId = $props.id();
const tools = [
  { tool: 'claude-code' as const, key: M['ui.connect_ai.claude'] },
  { tool: 'codex' as const, key: M['ui.connect_ai.codex'] },
];

async function refresh(): Promise<void> {
  if (stopped) return;
  if (refreshing) return refreshing;
  const pending = (async () => {
    try {
      const next = await client.state(active.signal);
      if (stopped) return;
      info = next;
      failed = false;
      if (!next.chatgpt.signingIn) signInUrl = undefined;
      onchange?.(next, next.configured);
    } catch {
      if (!stopped) failed = true;
    }
  })();
  refreshing = pending;
  try {
    await pending;
  } finally {
    if (refreshing === pending) refreshing = undefined;
  }
}

async function act(action: () => Promise<unknown>) {
  if (busy || stopped) return;
  busy = true;
  failed = false;
  try {
    await refreshing;
    await action();
    await refresh();
  } catch {
    if (!stopped) failed = true;
  } finally {
    if (!stopped) busy = false;
  }
}

async function startChatGPT() {
  const result = await client.startChatGPT(active.signal);
  // The server checks inference's canonical authorization URL policy. Keep a
  // browser-side protocol/host guard too; no SDK/server import in this entry.
  if (result.authorizationUrl) {
    const url = new URL(result.authorizationUrl);
    if (
      url.origin !== 'https://auth.openai.com' ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error('Invalid sign-in URL.');
    signInUrl = result.authorizationUrl;
  }
}

onMount(() => {
  stopped = false;
  void refresh();
  const focus = () => {
    if (!busy) void refresh();
  };
  window.addEventListener('focus', focus);
  const timer = setInterval(
    () => {
      if (
        !busy &&
        (info?.tools.some((tool) => tool.login === 'running') ||
          info?.chatgpt.signingIn)
      )
        void refresh();
    },
    Math.max(250, pollMs),
  );
  return () => {
    stopped = true;
    active.abort();
    clearInterval(timer);
    window.removeEventListener('focus', focus);
  };
});
</script>

<section class="smrt-connect-ai" data-smrt-component="ConnectAi" data-variant={variant} aria-labelledby={titleId} aria-busy={busy}>
  <h2 id={titleId}>{t(M['ui.connect_ai.title'])}</h2>
  {#if !info}
    <p role="status">{t(M['ui.connect_ai.loading'])}</p>
  {:else}
    <ul aria-label={t(M['ui.connect_ai.options'])}>
      {#each tools as option (option.tool)}
        {@const found = info.tools.find((tool) => tool.tool === option.tool)}
        {@const label = t(option.key)}
        <li>
          <Card>
            <div class="smrt-connect-ai__row">
              <div>
                <h3>{label}</h3>
                <p>{t(!found?.installed ? M['ui.connect_ai.missing'] : found.signedIn === null ? M['ui.connect_ai.unknown'] : found.signedIn ? M['ui.connect_ai.signed_in'] : M['ui.connect_ai.signed_out'])}</p>
                {#if found?.login === 'failed'}<p role="alert">{t(M['ui.connect_ai.sign_in_error'])}</p>{/if}
              </div>
              {#if !found?.installed}
                <Button href={safeHref(found?.installUrl ?? '') ?? undefined} target="_blank" rel="noopener noreferrer" variant="secondary">{t(M['ui.connect_ai.install'], { tool: label })} {t(M['ui.connect_ai.new_tab'])}</Button>
              {:else if found.signedIn && info.engine === option.tool}
                <Badge>{t(M['ui.connect_ai.in_use'])}</Badge>
              {:else}
                <Button disabled={busy || found.login === 'running'} onclick={() => act(() => found.signedIn === null ? refresh() : client.connect(option.tool, active.signal))}>
                  {t(found.login === 'running' ? M['ui.connect_ai.waiting'] : found.signedIn === null ? M['ui.connect_ai.retry'] : found.signedIn ? M['ui.connect_ai.use'] : M['ui.connect_ai.sign_in'], { tool: label })}
                </Button>
              {/if}
            </div>
          </Card>
        </li>
      {/each}
      <li>
        <Card>
          <div class="smrt-connect-ai__row">
            <div>
              <h3>{t(M['ui.connect_ai.chatgpt'])}</h3>
              <p>{t(info.chatgpt.signedIn ? M['ui.connect_ai.chatgpt_signed_in'] : info.chatgpt.signingIn ? M['ui.connect_ai.waiting'] : M['ui.connect_ai.chatgpt_description'])}</p>
              {#if info.chatgpt.error}<p role="alert">{t(M['ui.connect_ai.sign_in_error'])}</p>{/if}
            </div>
            <div class="smrt-connect-ai__actions">
              {#if info.chatgpt.signedIn && info.engine === 'chatgpt'}
                <Badge>{t(M['ui.connect_ai.in_use'])}</Badge>
              {:else}
                <Button disabled={busy || info.chatgpt.signingIn} onclick={() => act(() => info?.chatgpt.signedIn ? client.choose('chatgpt', active.signal) : startChatGPT())}>
                  {t(info.chatgpt.signingIn ? M['ui.connect_ai.waiting'] : info.chatgpt.signedIn ? M['ui.connect_ai.use'] : M['ui.connect_ai.sign_in'], { tool: t(M['ui.connect_ai.chatgpt']) })}
                </Button>
              {/if}
              {#if info.chatgpt.signedIn}
                <Button variant="secondary" disabled={busy} onclick={() => act(() => client.signOutChatGPT(active.signal))}>{t(M['ui.connect_ai.sign_out'])}</Button>
              {/if}
            </div>
          </div>
        </Card>
      </li>
      <li>
        <Card>
          <div class="smrt-connect-ai__row">
            <div><h3>{t(M['ui.connect_ai.api'])}</h3><p>{t(info.apiReady ? M['ui.connect_ai.api_saved'] : M['ui.connect_ai.api_missing'])}</p></div>
            {#if info.apiReady && info.engine === 'api'}
              <Badge>{t(M['ui.connect_ai.in_use'])}</Badge>
            {:else if info.apiReady}
              <Button disabled={busy} onclick={() => act(() => client.choose('api', active.signal))}>{t(M['ui.connect_ai.use_key'])}</Button>
            {:else}
              <Button href={safeHref(apiKeyHref) ?? undefined} variant="secondary">{t(M['ui.connect_ai.save_key'])}</Button>
            {/if}
          </div>
        </Card>
      </li>
    </ul>
    {#if signInUrl}
      <Button href={signInUrl} target="_blank" rel="noopener noreferrer" variant="secondary">{t(M['ui.connect_ai.open_sign_in'])} {t(M['ui.connect_ai.new_tab'])}</Button>
    {/if}
    <p role="status">{t(info.configured ? M['ui.connect_ai.ready'] : M['ui.connect_ai.not_ready'])}</p>
    <p>{t(M['ui.connect_ai.legal'])}</p>
    <p><a href="https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations" target="_blank" rel="noopener noreferrer">{t(M['ui.connect_ai.preview'])} {t(M['ui.connect_ai.new_tab'])}</a></p>
  {/if}
  {#if failed}
    <p role="alert">{t(M['ui.connect_ai.error'])}</p>
    <Button variant="secondary" disabled={busy} onclick={() => refresh()}>{t(M['ui.connect_ai.retry'])}</Button>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-connect-ai { display: grid; gap: var(--smrt-spacing-4); color: var(--smrt-color-on-surface); }
  .smrt-connect-ai ul { display: grid; gap: var(--smrt-spacing-3); list-style: none; margin: 0; padding: 0; }
  .smrt-connect-ai h2, .smrt-connect-ai h3, .smrt-connect-ai p { margin: 0; }
  .smrt-connect-ai p { margin-block-start: var(--smrt-spacing-2); }
  .smrt-connect-ai__row, .smrt-connect-ai__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); }
  .smrt-connect-ai [role='alert'] { color: var(--smrt-color-error); }
  .smrt-connect-ai a { color: var(--smrt-color-primary); }
}
</style>
