<script lang="ts">
// First-run welcome: 1. connect your AI, 2. how to start. Shown to the owner
// until it is finished or skipped; reachable any time from Settings.
import { tick } from 'svelte';
import { goto, invalidateAll } from '$app/navigation';
import { page } from '$app/state';
import ConnectAi from '$lib/components/ConnectAi.svelte';
import { ASSISTANT_OPEN_EVENT } from '$lib/ui/layout';
import {
  completeFresh,
  OnboardingError,
  skipOnboarding,
} from '$lib/ui/onboarding-client';

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
    await invalidateAll();
    await goto('/');
    // The layout is already mounted: ask it to open the chat column (it keeps
    // that choice for this owner).
    window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT));
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

<div class="smrt-app-shell__page smrt-app-shell-welcome__welcome">
  <header class="smrt-app-shell__head">
    <div>
      <p class="smrt-app-shell__sub" id="progress">Step {step} of 2</p>
      <h1 tabindex="-1" bind:this={heading} aria-describedby="progress">
        {step === 1 ? 'Connect your AI' : 'How do you want to start?'}
      </h1>
    </div>
    <button type="button" class="smrt-app-shell__btn" onclick={skip} disabled={busy}>Skip for now</button>
  </header>

  {#if step === 1}
    <section class="smrt-app-shell__card" aria-labelledby="connect-intro">
      <p id="connect-intro">
        The assistant builds and changes your app for you. It runs on your own
        Claude Code, or on your ChatGPT plan.
      </p>
      <ConnectAi onchange={(_info, ok) => (ready = ok)} />
    </section>
    <div class="smrt-app-shell-welcome__actions">
      <button type="button" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={!ready} onclick={() => go(2)}>Next</button>
      {#if !ready}
        <span class="smrt-app-shell__muted">Connect an AI to continue.</span>
      {/if}
    </div>
  {:else}
    <form
      class="smrt-app-shell__card"
      onsubmit={(e) => {
        e.preventDefault();
        if (start === 'fresh') void finish();
      }}
    >
      <fieldset>
        <legend class="smrt-app-shell__sr-only">Starting point</legend>
        <label class="smrt-app-shell__choice" class:smrt-app-shell__choice-on={start === 'fresh'}>
          <input type="radio" name="start" value="fresh" bind:group={start} />
          <span>
            <strong>Fresh</strong>
            <span class="smrt-app-shell__muted">Start with an empty app. Tell the assistant what to build.</span>
          </span>
        </label>
        <label class="smrt-app-shell__choice smrt-app-shell__choice-off">
          <input type="radio" name="start" value="wizard" disabled aria-describedby="wizard-soon" />
          <span>
            <strong>Wizard</strong>
            <span class="smrt-app-shell__muted" id="wizard-soon">A guided setup for a whole project. Coming soon.</span>
          </span>
        </label>
      </fieldset>
      <div class="smrt-app-shell-welcome__actions">
        <button type="button" class="smrt-app-shell__btn" onclick={() => go(1)} disabled={busy}>Back</button>
        <button type="submit" class="smrt-app-shell__btn smrt-app-shell__btn-primary" disabled={busy || start !== 'fresh'}>
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
    </form>
  {/if}

  <p class="smrt-app-shell__alert smrt-app-shell__alert-error" role="alert" hidden={!error}>{error}</p>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-app-shell-welcome__welcome {
    max-inline-size: 40rem;
  }
  .smrt-app-shell-welcome__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem) var(--smrt-spacing-md, 0.75rem);
    margin-block-start: var(--smrt-spacing-md, 0.75rem);
  }
  fieldset {
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
}

@layer smrt.theme {
  fieldset {
    border: 0;
  }
  h1:focus {
    outline: none;
  }
}
</style>
