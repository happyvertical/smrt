<script lang="ts">
// "Connect your AI": one button per tool found on this computer, plus the
// Advanced door to the full inference setup. It uses the Claude Code / Codex
// the person already has installed; signing in is that tool's own flow (it
// opens the vendor's page in the browser). This app never sees a login.
import { onDestroy, onMount } from 'svelte';
import {
  chooseEngine,
  connectTool,
  engineReady,
  fetchOnboarding,
  OnboardingError,
  type OnboardingInfo,
  type ToolInfo,
  toolAction,
} from '$lib/ui/onboarding-client';

let {
  advancedHref = '/settings/inference?from=welcome',
  onchange,
}: {
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

const ready = $derived(info ? engineReady(info) : false);

function say(text: string, error = false) {
  message = text;
  failed = error;
}

async function refresh(fresh = false) {
  try {
    info = await fetchOnboarding(fresh);
    onchange?.(info, engineReady(info));
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
    if (info?.tools.some((t) => t.login === 'running')) void refresh(true);
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
    <p class="sh-muted" role="status">Looking for Claude Code and Codex on this computer…</p>
  {:else}
    <ul class="sh-list tools" aria-label="Your AI">
      {#each info.tools as tool (tool.tool)}
        {@const action = toolAction(tool, info)}
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
      {/each}
    </ul>

    {#if info.apiReady}
      <p class="api">
        {#if info.engine === 'api'}
          <span class="sh-badge sh-badge-ok">In use</span> Your saved API key.
        {:else}
          You also have an API key saved.
          <button type="button" class="sh-btn sh-btn-small" disabled={busy !== null} onclick={useApi}>Use my API key</button>
        {/if}
      </p>
    {/if}

    <p class="sh-muted legal">
      This uses the app you already have installed, signed in the way its maker
      requires, and it bills your own account. This app never sees your login.
    </p>

    <p class="advanced">
      <a class="sh-link" href={advancedHref}>Advanced: use an API key or another provider</a>
    </p>
  {/if}

  <p class="sh-alert {failed ? 'sh-alert-error' : message ? 'sh-alert-ok' : ''} note" role={failed ? 'alert' : 'status'} hidden={!message}>{message}</p>
  <p class="sh-sr-only" role="status">{ready ? 'The assistant is ready.' : ''}</p>
</div>

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
