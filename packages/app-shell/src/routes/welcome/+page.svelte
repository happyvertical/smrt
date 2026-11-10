<script lang="ts">
// First-run welcome: 1. connect your AI, 2. how to start. Shown to the owner
// until it is finished or skipped; reachable any time from Settings.
import { tick } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import ConnectAi from '$lib/components/ConnectAi.svelte';
import {
  completeFresh,
  OnboardingError,
  skipOnboarding,
} from '$lib/ui/onboarding-client';

const OPEN_KEY = 'smrt-app-shell:assistant-open';

let step = $state<1 | 2>(page.url.searchParams.get('step') === '2' ? 2 : 1);
let ready = $state(false);
let start = $state<'fresh' | 'wizard'>('fresh');
let busy = $state(false);
let error = $state('');
let heading: HTMLHeadingElement | undefined = $state();

async function go(to: 1 | 2) {
  step = to;
  error = '';
  await tick();
  heading?.focus();
}

async function finish() {
  busy = true;
  error = '';
  try {
    await completeFresh();
    // Land in the shell with the assistant open and ready to use.
    try {
      localStorage.setItem(OPEN_KEY, '1');
    } catch {
      // storage is optional
    }
    await invalidateAll();
    await goto('/');
    // The dock is already mounted: ask it to open.
    window.dispatchEvent(new CustomEvent('smrt-app-shell:open-assistant'));
  } catch (e) {
    error = e instanceof OnboardingError ? e.message : 'Something went wrong.';
  } finally {
    busy = false;
  }
}

async function skip() {
  busy = true;
  try {
    await skipOnboarding();
    await invalidateAll();
    await goto('/');
  } catch (e) {
    error = e instanceof OnboardingError ? e.message : 'Something went wrong.';
  } finally {
    busy = false;
  }
}
</script>

<svelte:head><title>Welcome</title></svelte:head>

<div class="sh-page welcome">
  <header class="sh-head">
    <div>
      <p class="sh-sub" id="progress">Step {step} of 2</p>
      <h1 tabindex="-1" bind:this={heading} aria-describedby="progress">
        {step === 1 ? 'Connect your AI' : 'How do you want to start?'}
      </h1>
    </div>
    <button type="button" class="sh-btn" onclick={skip} disabled={busy}>Skip for now</button>
  </header>

  {#if step === 1}
    <section class="sh-card" aria-labelledby="connect-intro">
      <p id="connect-intro">
        The assistant builds and changes your app for you. It runs on your own
        Claude Code or Codex.
      </p>
      <ConnectAi onchange={(_info, ok) => (ready = ok)} />
    </section>
    <div class="actions">
      <button type="button" class="sh-btn sh-btn-primary" disabled={!ready} onclick={() => go(2)}>Next</button>
      {#if !ready}
        <span class="sh-muted">Connect an AI to continue.</span>
      {/if}
    </div>
  {:else}
    <form
      class="sh-card"
      onsubmit={(e) => {
        e.preventDefault();
        if (start === 'fresh') void finish();
      }}
    >
      <fieldset>
        <legend class="sr-only">Starting point</legend>
        <label class="choice" class:chosen={start === 'fresh'}>
          <input type="radio" name="start" value="fresh" bind:group={start} />
          <span>
            <strong>Fresh</strong>
            <span class="sh-muted">Start with an empty app. Tell the assistant what to build.</span>
          </span>
        </label>
        <label class="choice off">
          <input type="radio" name="start" value="wizard" disabled aria-describedby="wizard-soon" />
          <span>
            <strong>Wizard</strong>
            <span class="sh-muted" id="wizard-soon">A guided setup for a whole project. Coming soon.</span>
          </span>
        </label>
      </fieldset>
      <div class="actions">
        <button type="button" class="sh-btn" onclick={() => go(1)} disabled={busy}>Back</button>
        <button type="submit" class="sh-btn sh-btn-primary" disabled={busy || start !== 'fresh'}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </form>
  {/if}

  <p class="sh-alert sh-alert-error" role="alert" hidden={!error}>{error}</p>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .welcome {
    max-inline-size: 40rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    margin-block-start: var(--smrt-spacing-md, 0.75rem);
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .choice {
    display: flex;
    gap: var(--smrt-spacing-md, 0.75rem);
    align-items: flex-start;
    padding: var(--smrt-spacing-md, 0.75rem);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 0.5rem);
    cursor: pointer;
  }
  .choice span {
    display: flex;
    flex-direction: column;
  }
  .choice.chosen {
    border-color: var(--smrt-color-primary);
  }
  .choice.off {
    cursor: not-allowed;
    opacity: 0.7;
  }
  .choice:focus-within {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
  h1:focus {
    outline: none;
  }
  .sr-only {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
