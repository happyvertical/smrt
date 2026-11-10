<script lang="ts">
// "Connect your AI": Claude Code (the tool already on this computer; signing
// in is its own flow), "Sign in with ChatGPT" (OpenAI's official flow for open
// source apps, a preview: the system browser opens OpenAI's page and this app
// never sees a password or token), plus the Advanced door to the full
// inference setup. Codex, also a local tool, is an advanced option shown on
// the Settings variant only.
import { onDestroy, onMount } from 'svelte';
import {
  apiRow,
  type ChatGPTState,
  chatgptAction,
  chatgptDescription,
  chooseChatGPTModel,
  chooseEngine,
  connectTool,
  engineReady,
  fetchChatGPT,
  fetchOnboarding,
  OnboardingError,
  type OnboardingInfo,
  signOutChatGPT,
  startChatGPT,
  type ToolInfo,
  toolAction,
  visibleTools,
} from '$lib/ui/onboarding-client';

let {
  advancedHref = '/settings/inference?from=welcome',
  variant = 'welcome',
  onchange,
}: {
  /**
   * `welcome` offers Claude Code and ChatGPT; `settings` also lists Codex as
   * an advanced option and lets the owner pick the ChatGPT model.
   */
  variant?: 'welcome' | 'settings';
  /** Where "Advanced" goes (the full inference setup). */
  advancedHref?: string;
  /** Called with the readiness after every refresh. */
  onchange?: (info: OnboardingInfo, ready: boolean) => void;
} = $props();

let info = $state<OnboardingInfo | null>(null);
let busy = $state<string | null>(null);
let message = $state('');
let failed = $state(false);
let timer: ReturnType<typeof setInterval> | undefined;
// Tools whose sign-in this page started: select one when it finishes.
const awaiting = new Set<string>();
// A ChatGPT sign-in this page started: select the engine when it finishes.
let awaitingChatGPT = false;
// Set when the page (not the app) must open OpenAI's page: a plain new-tab link.
let signInUrl = $state<string | null>(null);
let chatgptState = $state<ChatGPTState | null>(null);

const ready = $derived(info ? engineReady(info) : false);
const shown = $derived(
  info ? visibleTools(info, variant) : { main: [], advanced: [] },
);
const mainTools = $derived(shown.main);
const advancedTools = $derived(shown.advanced);

function say(text: string, error = false) {
  message = text;
  failed = error;
}

async function refresh(fresh = false) {
  try {
    info = await fetchOnboarding(fresh);
    onchange?.(info, engineReady(info));
    if (awaitingChatGPT && busy === null) await finishChatGPT(info);
    if (variant === 'settings' && info.chatgpt?.signedIn) {
      try {
        chatgptState = await fetchChatGPT();
      } catch {
        chatgptState = null;
      }
    } else chatgptState = null;
    // A sign-in this page started has finished: select the tool, no extra click.
    for (const tool of info.tools) {
      if (
        awaiting.has(tool.tool) &&
        tool.login !== 'running' &&
        busy === null
      ) {
        awaiting.delete(tool.tool);
        if (tool.signedIn === true && info.engine !== tool.tool)
          await use(tool);
        else if (tool.signedIn !== true)
          say(`Signing in to ${tool.label} did not finish. Try again.`, true);
      }
    }
  } catch (error) {
    say(
      error instanceof OnboardingError ? error.message : 'Could not check.',
      true,
    );
  }
}

async function use(tool: ToolInfo) {
  busy = tool.tool;
  say(`Checking ${tool.label}…`);
  try {
    const out = await connectTool(tool.tool);
    if (out.result === 'ready') say(`${tool.label} is connected.`);
    else if (out.result === 'missing')
      say(`${tool.label} is not installed.`, true);
    else {
      awaiting.add(tool.tool);
      say(
        `Finish signing in to ${tool.label} in your browser. This page updates when you are done.`,
      );
    }
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

async function finishChatGPT(now: OnboardingInfo) {
  const chatgpt = now.chatgpt;
  if (chatgpt?.signedIn) {
    awaitingChatGPT = false;
    signInUrl = null;
    if (now.engine !== 'chatgpt') await useChatGPT();
  } else if (chatgpt && !chatgpt.signingIn) {
    awaitingChatGPT = false;
    signInUrl = null;
    say(
      chatgpt.error?.message ??
        'Sign-in with ChatGPT did not finish. Try again.',
      true,
    );
  }
}

async function useChatGPT() {
  busy = 'chatgpt';
  try {
    await chooseEngine('chatgpt');
    say('Using ChatGPT.');
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

async function signInChatGPT() {
  busy = 'chatgpt';
  say('Opening ChatGPT in your browser…');
  try {
    const out = await startChatGPT();
    awaitingChatGPT = true;
    if (out.opened) {
      signInUrl = null;
      say(
        'Finish signing in with ChatGPT in your browser. This page updates when you are done.',
      );
    } else if (out.authorizationUrl) {
      signInUrl = out.authorizationUrl;
      say(
        'Open the ChatGPT sign-in page below. This page updates when you are done.',
      );
    }
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

async function signOutOfChatGPT() {
  busy = 'chatgpt';
  try {
    await signOutChatGPT();
    awaitingChatGPT = false;
    say('Signed out of ChatGPT.');
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

async function pickModel(event: Event) {
  const value = (event.currentTarget as HTMLSelectElement).value;
  busy = 'chatgpt';
  try {
    await chooseChatGPTModel(value || null);
    say('Model saved.');
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

async function useApi() {
  busy = 'api';
  try {
    await chooseEngine('api');
    say('Using your API key.');
    await refresh(true);
  } catch (error) {
    say(
      error instanceof OnboardingError
        ? error.message
        : 'Something went wrong.',
      true,
    );
  } finally {
    busy = null;
  }
}

const refreshOnFocus = () => void refresh(true);

onMount(() => {
  void refresh(true);
  window.addEventListener('focus', refreshOnFocus);
  // While a sign-in is open, look again every few seconds.
  timer = setInterval(() => {
    if (
      info?.tools.some((t) => t.login === 'running') ||
      info?.chatgpt?.signingIn
    )
      void refresh(true);
  }, 2500);
});
onDestroy(() => {
  if (typeof window !== 'undefined')
    window.removeEventListener('focus', refreshOnFocus);
  if (timer) clearInterval(timer);
});
</script>

<div class="connect">
  {#if !info}
    <p class="sh-muted" role="status">Looking for the AI you can use on this computer…</p>
  {:else}
    {@const gpt = chatgptAction(info)}
    <ul class="sh-list tools" aria-label="Your AI">
      {#each mainTools as tool (tool.tool)}
        {@render toolRow(tool, info)}
      {/each}
      <li class="tool" id="chatgpt">
        <div class="what">
          <strong>ChatGPT</strong>
          <span class="sh-muted">{chatgptDescription(info)}</span>
          {#if variant === 'settings' && info.chatgpt?.signedIn && chatgptState?.models?.length}
            <label class="model">
              <span class="sh-muted">Model</span>
              <select class="sh-input" disabled={busy !== null} value={chatgptState.model ?? ''} onchange={pickModel}>
                <option value="">Default ({chatgptState.models[0].label})</option>
                {#each chatgptState.models as m (m.id)}
                  <option value={m.id}>{m.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>
        <div class="row-actions">
          {#if gpt.kind === 'in-use'}
            <span class="sh-badge sh-badge-ok">{gpt.label}</span>
          {:else}
            <button
              type="button"
              class="sh-btn {gpt.kind === 'use' || gpt.kind === 'sign-in' ? 'sh-btn-primary' : ''}"
              disabled={busy !== null || gpt.kind === 'waiting'}
              onclick={() => (gpt.kind === 'use' ? useChatGPT() : signInChatGPT())}
            >{gpt.label}</button>
          {/if}
          {#if info.chatgpt?.signedIn}
            <button type="button" class="sh-btn" disabled={busy !== null} onclick={signOutOfChatGPT}>Sign out</button>
          {/if}
        </div>
      </li>
    </ul>
    {#if signInUrl}
      <p class="api">
        <a class="sh-link" href={signInUrl} target="_blank" rel="noopener noreferrer">Open the ChatGPT sign-in page<span class="sh-sr-only"> (opens in a new tab)</span></a>
      </p>
    {/if}

    {#if advancedTools.length}
      <details class="advanced-tools">
        <summary>Advanced: other tools on this computer</summary>
        <ul class="sh-list tools" aria-label="Advanced tools">
          {#each advancedTools as tool (tool.tool)}
            {@render toolRow(tool, info)}
          {/each}
        </ul>
      </details>
    {/if}

    {@const api = apiRow(info)}
    {#if api === 'in-use'}
      <p class="api">
        <span class="sh-badge sh-badge-ok">In use</span> An API key (saved here, or found in this computer's settings).
      </p>
    {:else if api === 'available'}
      <p class="api">
        You also have an API key available.
        <button type="button" class="sh-btn sh-btn-small" disabled={busy !== null} onclick={useApi}>Use my API key</button>
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
      <a class="sh-link" href={advancedHref}>Advanced: use an API key or another provider</a>
    </p>
  {/if}

  <p class="sh-alert {failed ? 'sh-alert-error' : message ? 'sh-alert-ok' : ''} note" role={failed ? 'alert' : 'status'} hidden={!message}>{message}</p>
  <p class="sh-sr-only" role="status">{ready ? 'The assistant is ready.' : ''}</p>
</div>

{#snippet toolRow(tool: ToolInfo, current: OnboardingInfo)}
  {@const action = toolAction(tool, current)}
  <li class="tool">
    <div class="what">
      <strong>{tool.label}</strong>
      <span class="sh-muted">
        {#if !tool.installed}
          Not installed on this computer.
        {:else if tool.signedIn === null}
          Installed, but it did not answer.
        {:else if tool.signedIn}
          Installed and signed in{tool.version ? `, version ${tool.version}` : ''}.
        {:else}
          Installed, not signed in.
        {/if}
      </span>
    </div>
    {#if action.kind === 'install'}
      <a
        class="sh-btn"
        href={tool.installUrl}
        target="_blank"
        rel="noopener noreferrer"
      >{action.label}<span class="sh-sr-only"> for {tool.label} (opens in a new tab)</span></a>
    {:else if action.kind === 'in-use'}
      <span class="sh-badge sh-badge-ok">{action.label}</span>
    {:else}
      <button
        type="button"
        class="sh-btn {action.kind === 'use' || action.kind === 'sign-in' ? 'sh-btn-primary' : ''}"
        disabled={busy !== null || action.kind === 'waiting'}
        onclick={() => (action.kind === 'retry' ? refresh(true) : use(tool))}
      >{action.label}</button>
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
    gap: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    padding-block: var(--smrt-spacing-sm, 0.5rem);
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
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .model {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-xs, 0.25rem);
    margin-block-start: var(--smrt-spacing-sm, 0.5rem);
    max-inline-size: 18rem;
  }
  .advanced-tools {
    margin-block-start: var(--smrt-spacing-md, 0.75rem);
  }
  .legal,
  .advanced,
  .api {
    margin-block: var(--smrt-spacing-md, 0.75rem) 0;
  }
  .note {
    margin-block-start: var(--smrt-spacing-md, 0.75rem);
  }
}
</style>
