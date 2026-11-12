<script lang="ts">
import { Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import { onMount, untrack } from 'svelte';
import { M } from '../../i18n/strings.connect-ai.js';
import { safeHref } from '../overview/markdown.js';
import {
  apiRow,
  chatgptAction,
  chatgptDescription,
  engineReady,
  toolAction,
  visibleTools,
} from './client.js';
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
  /** Compact saved-product wording/grouping; defaults stay unchanged. */
  presentation?: 'compact';
  /** Parent step heading. Reuses its name instead of rendering a second heading. */
  headingId?: string;
}

let {
  client,
  apiKeyHref,
  variant = 'onboarding',
  initialState,
  onchange,
  pollMs = 2500,
  presentation,
  headingId,
}: Props = $props();
const { t } = useI18n();
let info = $state<ConnectAiState | undefined>(untrack(() => initialState));
let busy = $state(false);
let failed = $state(false);
let signInUrl = $state<string | undefined>();
let message = $state('');
let chatgptState = $state<{
  model: string | null;
  models?: { id: string; label: string }[];
}>();
const awaiting = new Set<string>();
let awaitingChatGPT = false;
const ready = $derived(info ? engineReady(info) : false);
const compactInfo = $derived(
  info
    ? {
        ...info,
        tools: info.tools.map((tool) => ({
          ...tool,
          label:
            tool.label ?? (tool.tool === 'codex' ? 'Codex' : 'Claude Code'),
        })),
      }
    : undefined,
);
const shown = $derived(
  compactInfo ? visibleTools(compactInfo, variant) : { main: [], advanced: [] },
);
const mainTools = $derived(shown.main);
const advancedTools = $derived(shown.advanced);
let stopped = false;
let refreshing: Promise<void> | undefined;
const active = new AbortController();
const titleId = $props.id();
const tools = [
  { tool: 'claude-code' as const, key: M['ui.connect_ai.claude'] },
  { tool: 'chatgpt' as const, key: M['ui.connect_ai.chatgpt'] },
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
      if (presentation !== 'compact') failed = false;
      if (!next.chatgpt.signingIn && !awaitingChatGPT) signInUrl = undefined;
      onchange?.(next, engineReady(next));
      if (presentation === 'compact') {
        if (!busy) {
          for (const tool of next.tools) {
            if (!awaiting.has(tool.tool) || tool.login === 'running') continue;
            awaiting.delete(tool.tool);
            if (
              tool.signedIn &&
              tool.ready === true &&
              next.engine !== tool.tool
            ) {
              await client.connect(tool.tool, active.signal);
              info = await client.state(active.signal);
              onchange?.(info, engineReady(info));
            } else if (!tool.signedIn) {
              message = `Signing in to ${tool.label ?? (tool.tool === 'codex' ? 'Codex' : 'Claude Code')} did not finish. Try again.`;
              failed = true;
            }
          }
          if (awaitingChatGPT && !next.chatgpt.signingIn) {
            awaitingChatGPT = false;
            signInUrl = undefined;
            if (next.chatgpt.signedIn) {
              await client.choose('chatgpt', active.signal);
              info = await client.state(active.signal);
              onchange?.(info, engineReady(info));
            } else {
              message =
                next.chatgpt.error?.message ??
                'Sign-in with ChatGPT did not finish. Try again.';
              failed = true;
            }
          }
        }
        chatgptState =
          variant === 'settings' && info?.chatgpt.signedIn
            ? await client.modelState?.(active.signal).catch(() => undefined)
            : undefined;
      }
    } catch (error) {
      if (!stopped) {
        failed = true;
        if (presentation === 'compact')
          message = client.errorMessage?.(error) ?? 'Could not check.';
      }
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
  } catch (error) {
    if (!stopped) {
      failed = true;
      if (presentation === 'compact')
        message = client.errorMessage?.(error) ?? 'Something went wrong.';
    }
  } finally {
    if (!stopped) {
      busy = false;
      if (presentation === 'compact' && (awaiting.size || awaitingChatGPT))
        void refresh();
    }
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
  if (presentation === 'compact') awaitingChatGPT = true;
}

async function use(tool: ConnectAiState['tools'][number]) {
  const label = tool.label ?? (tool.tool === 'codex' ? 'Codex' : 'Claude Code');
  message = `Checking ${label}…`;
  await act(async () => {
    const result = client.connectOutcome
      ? await client.connectOutcome(tool.tool, active.signal)
      : await client.connect(tool.tool, active.signal);
    if (result?.result === 'missing') {
      message = `${label} is not installed.`;
      failed = true;
    } else if (
      result?.result === 'ready' ||
      (tool.signedIn && tool.ready === true)
    )
      message = `${label} is connected.`;
    else {
      awaiting.add(tool.tool);
      message = `Finish signing in to ${label} in your browser. This page updates when you are done.`;
    }
  });
}
const useChatGPT = () =>
  act(async () => {
    await client.choose('chatgpt', active.signal);
    message = 'Using ChatGPT.';
  });
const signInChatGPT = () =>
  act(async () => {
    message = 'Opening ChatGPT in your browser…';
    await startChatGPT();
    message = signInUrl
      ? 'Open the ChatGPT sign-in page below. This page updates when you are done.'
      : 'Finish signing in with ChatGPT in your browser. This page updates when you are done.';
  });
const signOutOfChatGPT = () =>
  act(async () => {
    await client.signOutChatGPT(active.signal);
    awaitingChatGPT = false;
    message = 'Signed out of ChatGPT.';
  });
const useApi = () =>
  act(async () => {
    await client.choose('api', active.signal);
    message = 'Using your API key.';
  });
async function pickModel(event: Event) {
  const value = (event.currentTarget as HTMLSelectElement).value;
  await act(async () => {
    await client.chooseModel?.(value || null, active.signal);
    message = 'Model saved.';
  });
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

{#if presentation === 'compact'}
<div class="connect" data-smrt-component="ConnectAi" data-variant={variant}>
  {#if !compactInfo}
    <p class="sh-muted" role="status">Looking for the AI you can use on this computer…</p>
  {:else}
    {@const gpt = chatgptAction(compactInfo)}
    <ul class="sh-list tools" aria-label="Your AI">
      {#each mainTools as tool (tool.tool)}
        {@render toolRow(tool, compactInfo)}
      {/each}
      <li class="tool" id="chatgpt">
        <div class="what">
          <strong>ChatGPT</strong>
          <span class="sh-muted">{t(M['ui.connect_ai.chatgpt_recommended'])}</span>
          <span class="sh-muted">{chatgptDescription(compactInfo)}</span>
          {#if variant === 'settings' && compactInfo.chatgpt?.signedIn && chatgptState?.models?.length}
            <label class="model">
              <span class="sh-muted">Model</span>
              <Select class="sh-input" disabled={busy} value={chatgptState.model ?? ''} onchange={pickModel}>
                <option value="">{t(M['ui.connect_ai.recommended_model'])}</option>
                {#each chatgptState.models as m (m.id)}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </Select>
            </label>
          {/if}
        </div>
        <div class="row-actions">
          {#if gpt.kind === 'in-use'}
            <span class="sh-badge sh-badge-ok">{gpt.label}</span>
          {:else}
            <Button
              type="button"
              class="sh-btn {gpt.kind === 'use' || gpt.kind === 'sign-in' ? 'sh-btn-primary' : ''}"
              disabled={busy || gpt.kind === 'waiting'}
              onclick={() => (gpt.kind === 'use' ? useChatGPT() : signInChatGPT())}
            >{gpt.label}</Button>
          {/if}
          {#if compactInfo.chatgpt?.signedIn}
            <Button type="button" class="sh-btn" disabled={busy} onclick={signOutOfChatGPT}>Sign out</Button>
          {/if}
        </div>
      </li>
      {#each advancedTools as tool (tool.tool)}
        {@render toolRow(tool, compactInfo)}
      {/each}
    </ul>
    {#if signInUrl}
      <p class="api">
        <a class="sh-link" href={signInUrl} target="_blank" rel="noopener noreferrer">Open the ChatGPT sign-in page<span class="sh-sr-only"> (opens in a new tab)</span></a>
      </p>
    {/if}

    {@const api = apiRow(compactInfo)}
    {#if api === 'in-use'}
      <p class="api">
        <span class="sh-badge sh-badge-ok">In use</span> An API key (saved here, or found in this computer's settings).
      </p>
    {:else if api === 'available'}
      <p class="api">
        You also have an API key available.
        <Button type="button" class="sh-btn sh-btn-small" disabled={busy} onclick={useApi}>Use my API key</Button>
      </p>
    {:else if !ready}
      <p class="api sh-muted">Nothing connected yet.</p>
    {/if}

    <p class="sh-muted legal">
      Claude Code runs the app you already have installed, signed in the way its
      maker requires. Sign in with ChatGPT uses OpenAI's own sign-in page, a
      <a class="sh-link" href="https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations" target="_blank" rel="noopener noreferrer">preview for open source apps<span class="sh-sr-only"> (opens in a new tab)</span></a>.
      Either bills your own account, and this app never sees your password.
    </p>

    <p class="advanced">
      <a class="sh-link" href={safeHref(apiKeyHref) ?? undefined}>Advanced: use an API key or another provider</a>
    </p>
  {/if}

  <p class="sh-alert {failed ? 'sh-alert-error' : message ? 'sh-alert-ok' : ''} note" role={failed ? 'alert' : 'status'} hidden={!message && !failed}>{message || (failed ? t(M['ui.connect_ai.error']) : '')}</p>
  <p class="sh-sr-only" role="status">{ready ? 'The assistant is ready.' : ''}</p>
</div>

{:else}
<section class="smrt-connect-ai" data-smrt-component="ConnectAi" data-variant={variant} aria-labelledby={headingId ?? titleId} aria-busy={busy}>
  {#if !headingId}<h2 id={titleId}>{t(M['ui.connect_ai.title'])}</h2>{/if}
  {#if !info}
    <p role="status">{t(M['ui.connect_ai.loading'])}</p>
  {:else}
    <ul aria-label={t(M['ui.connect_ai.options'])}>
      {#each tools as option (option.tool)}
        {#if option.tool === 'chatgpt'}
      <li>
        <Card>
          <div class="smrt-connect-ai__row">
            <div>
              <h3>{t(M['ui.connect_ai.chatgpt'])}</h3>
              <p>{t(M['ui.connect_ai.chatgpt_recommended'])}</p>
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
        {:else}
        {@const found = info.tools.find((tool) => tool.tool === option.tool)}
        {@const label = t(option.key)}
        <li>
          <Card>
            <div class="smrt-connect-ai__row">
              <div>
                <h3>{label}</h3>
                {#if option.tool === 'codex'}<p>{t(M['ui.connect_ai.codex_description'])}</p>{/if}
                <p>{t(!found?.installed ? M['ui.connect_ai.missing'] : found.signedIn === null ? M['ui.connect_ai.unknown'] : found.signedIn && found.ready !== true ? M['ui.connect_ai.unusable'] : found.signedIn ? M['ui.connect_ai.signed_in'] : M['ui.connect_ai.signed_out'])}</p>
                {#if found?.startError}<p role="alert">{t(M[`ui.connect_ai.${found.startError}`])}</p>{/if}
                {#if found?.login === 'failed'}<p role="alert">{t(M['ui.connect_ai.sign_in_error'])}</p>{/if}
              </div>
              {#if !found?.installed}
                <Button href={safeHref(found?.installUrl ?? '') ?? undefined} target="_blank" rel="noopener noreferrer" variant="secondary">{t(M['ui.connect_ai.install'], { tool: label })} {t(M['ui.connect_ai.new_tab'])}</Button>
              {:else if found.signedIn && found.ready === true && info.engine === option.tool}
                <Badge>{t(M['ui.connect_ai.in_use'])}</Badge>
              {:else}
                <Button disabled={busy || found.login === 'running'} onclick={() => act(() => found.signedIn === null || (found.signedIn && found.ready !== true) ? refresh() : client.connect(option.tool, active.signal))}>
                  {t(found.login === 'running' ? M['ui.connect_ai.waiting'] : found.signedIn === null || (found.signedIn && found.ready !== true) ? M['ui.connect_ai.retry'] : found.signedIn ? M['ui.connect_ai.use'] : M['ui.connect_ai.sign_in'], { tool: label })}
                </Button>
              {/if}
            </div>
          </Card>
        </li>
        {/if}
      {/each}
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
    <p role="status">{t(engineReady(info) ? M['ui.connect_ai.ready'] : M['ui.connect_ai.not_ready'])}</p>
    <p>{t(M['ui.connect_ai.legal'])}</p>
    <p><a href="https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations" target="_blank" rel="noopener noreferrer">{t(M['ui.connect_ai.preview'])} {t(M['ui.connect_ai.new_tab'])}</a></p>
  {/if}
  {#if failed}
    <p role="alert">{t(M['ui.connect_ai.error'])}</p>
    <Button variant="secondary" disabled={busy} onclick={() => refresh()}>{t(M['ui.connect_ai.retry'])}</Button>
  {/if}
</section>

{/if}

{#snippet toolRow(tool: ConnectAiState['tools'][number], current: ConnectAiState)}
  {@const action = toolAction(tool, current)}
  <li class="tool">
    <div class="what">
      <strong>{tool.label}</strong>
      {#if tool.tool === 'codex'}<span class="sh-muted">{t(M['ui.connect_ai.codex_description'])}</span>{/if}
      <span class="sh-muted">
        {#if !tool.installed}
          Not installed on this computer.
        {:else if tool.signedIn === null}
          Installed, but it did not answer.
        {:else if tool.signedIn && tool.ready !== true}
          {t(M['ui.connect_ai.unusable'])}
        {:else if tool.signedIn}
          {t(tool.version ? M['ui.connect_ai.ready_version'] : M['ui.connect_ai.signed_in'], { version: tool.version ?? '' })}
        {:else}
          Installed, not signed in.
        {/if}
      </span>
      {#if tool.startError}<p role="alert">{t(M[`ui.connect_ai.${tool.startError}`])}</p>{/if}
    </div>
    {#if action.kind === 'install'}
      <a
        class="sh-btn"
        href={safeHref(tool.installUrl) ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
      >{action.label}<span class="sh-sr-only"> for {tool.label} (opens in a new tab)</span></a>
    {:else if action.kind === 'in-use'}
      <span class="sh-badge sh-badge-ok">{action.label}</span>
    {:else}
      <Button
        type="button"
        class="sh-btn {action.kind === 'use' || action.kind === 'sign-in' ? 'sh-btn-primary' : ''}"
        disabled={busy || action.kind === 'waiting'}
        onclick={() => (action.kind === 'retry' ? refresh() : use(tool))}
      >{action.label}</Button>
    {/if}
  </li>
{/snippet}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .tools {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .tool {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2) var(--smrt-spacing-3);
    padding-block: var(--smrt-spacing-2);
  }
  .what {
    display: flex;
    flex-direction: column;
    min-inline-size: 12rem;
    flex: 1 1 12rem;
  }
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }
  .model {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    margin-block-start: var(--smrt-spacing-2);
    max-inline-size: 18rem;
  }
  .legal,
  .advanced,
  .api {
    margin-block: var(--smrt-spacing-3) 0;
  }
  .note {
    margin-block-start: var(--smrt-spacing-3);
  }
  .smrt-connect-ai { display: grid; gap: var(--smrt-spacing-4); color: var(--smrt-color-on-surface); }
  .smrt-connect-ai ul { display: grid; gap: var(--smrt-spacing-3); list-style: none; margin: 0; padding: 0; }
  .smrt-connect-ai h2, .smrt-connect-ai h3, .smrt-connect-ai p { margin: 0; }
  .smrt-connect-ai p { margin-block-start: var(--smrt-spacing-2); }
  .smrt-connect-ai__row, .smrt-connect-ai__actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); }
  .smrt-connect-ai [role='alert'] { color: var(--smrt-color-error); }
  .smrt-connect-ai a { color: var(--smrt-color-primary); }
}
</style>
