<script lang="ts">
import {
  AssistantApprovalCard,
  type AssistantTransport,
} from '@happyvertical/smrt-chat/svelte';
import type { InferenceEngineAction } from '@happyvertical/smrt-inference/server';
import { ConfirmDialog, Progress } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { onMount, tick, untrack } from 'svelte';
import { M } from '../../i18n/strings.onboarding.js';
import ConnectAi from '../connect-ai/ConnectAi.svelte';
import type { ConnectAiClient } from '../connect-ai/types.js';
import { safeHref } from '../overview/markdown.js';
import type {
  OnboardingAction,
  OnboardingClient,
  OnboardingState,
} from './types.js';

let {
  client,
  connectAi,
  approvalTransport,
  initialState,
  appName,
  description,
  apiKeyHref,
  oncomplete,
  backHref = '/settings',
  aiAlternative,
}: {
  client: OnboardingClient;
  connectAi: ConnectAiClient;
  approvalTransport: AssistantTransport;
  initialState: OnboardingState;
  appName: string;
  description: string;
  apiKeyHref: string;
  oncomplete: () => void | Promise<void>;
  backHref?: string;
  /** Host-owned alternative connection link, inside the AI step card. */
  aiAlternative?: InferenceEngineAction;
} = $props();
const { t } = useI18n();
let progress = $state<OnboardingState>(untrack(() => initialState));
let busy = $state(false);
let failed = $state(false);
let ready = $state(false);
let confirming = $state(false);
let heading: HTMLHeadingElement;
let reviewHeading = $state<HTMLHeadingElement>();
let decision = $state<HTMLElement>();
let errorNotice = $state<HTMLElement>();
const headingId = $props.id();
const active = new AbortController();
let disposed = false;
async function accept(next: OnboardingState) {
  if (disposed) return;
  progress = next;
  if (next.step === 'done' && !next.rerunning) {
    await oncomplete();
    return;
  }
  await tick();
  const target = next.approvalId
    ? decision
    : next.preview
      ? reviewHeading
      : heading;
  target?.focus({ preventScroll: true });
  target?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
}
async function change(action: OnboardingAction) {
  if (busy) return;
  busy = true;
  failed = false;
  try {
    await accept(await client.change(action, progress.revision, active.signal));
  } catch {
    if (!disposed) failed = true;
    await tick();
    errorNotice?.focus();
    errorNotice?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
  } finally {
    if (!disposed) busy = false;
  }
}
async function refresh() {
  busy = true;
  failed = false;
  try {
    await accept(await client.state(active.signal));
  } catch {
    if (!disposed) failed = true;
    await tick();
    errorNotice?.focus();
    errorNotice?.scrollIntoView?.({ block: 'center', behavior: 'instant' });
  } finally {
    if (!disposed) busy = false;
  }
}
onMount(() => {
  heading?.focus();
  return () => {
    disposed = true;
    active.abort();
  };
});
const pendingApproval = $derived(
  !!progress.approvalId &&
    (!progress.approval ||
      ['pending', 'approved', 'executing'].includes(progress.approval.status)),
);
const title = $derived(
  progress.step === 'welcome'
    ? t(M['ui.onboarding.welcome'], { app: appName })
    : progress.step === 'ai'
      ? t(M['ui.onboarding.ai'])
      : t(M['ui.onboarding.templates']),
);
const step = $derived(
  progress.step === 'welcome' ? 1 : progress.step === 'ai' ? 2 : 3,
);
</script>

<main class="smrt-first-run-onboarding__onboarding" data-smrt-component="FirstRunOnboarding" aria-busy={busy}>
<div class="smrt-first-run-onboarding__onboarding-content">
  <Card padding="lg">
    <p>{t(M['ui.onboarding.step'], { step, total: 3 })}</p>
    <Progress value={step} max={3} label={t(M['ui.onboarding.step'], { step, total: 3 })} />
    <h1 id={headingId} bind:this={heading} tabindex="-1">{title}</h1>
    {#if progress.step === 'welcome'}
      <p>{description}</p>
      <p>{t(M['ui.onboarding.owner'])}</p>
      <Button disabled={busy} onclick={() => change({ action: 'welcome' })}>{t(M['ui.onboarding.start'])}</Button>
      {#if progress.completed || progress.rerunning}<Button variant="ghost" href={backHref}>{t(M['ui.onboarding.back_settings'])}</Button>{/if}
    {:else if progress.step === 'ai'}
      <ConnectAi client={connectAi} {apiKeyHref} {headingId} onchange={(_, configured) => { ready = configured; }} />
      {#if aiAlternative && safeHref(aiAlternative.href)}
        <Button variant="secondary" href={safeHref(aiAlternative.href) ?? undefined}>{aiAlternative.label}</Button>
      {/if}
      {#if !ready}<p>{t(M['ui.onboarding.skip_hint'])}</p>{/if}
      <div class="smrt-first-run-onboarding__actions">
        <Button variant="ghost" disabled={busy} onclick={() => change({ action: 'back' })}>{t(M['ui.onboarding.back'])}</Button>
        {#if !ready}<Button variant="secondary" disabled={busy} onclick={() => change({ action: 'skip' })}>{t(M['ui.onboarding.skip'])}</Button>{/if}
        <Button disabled={busy || !ready} onclick={() => change({ action: 'continue' })}>{t(M['ui.onboarding.continue'])}</Button>
      </div>
    {:else if progress.step === 'template'}
      {#if !progress.templates.length}<p>{t(M['ui.onboarding.templates_off'])}</p>{/if}
      <div class="smrt-first-run-onboarding__templates">
        {#each progress.templates as template (template.id)}
          <Card>
            <h2>{template.id === 'fresh' ? t(M['ui.onboarding.fresh']) : template.name}</h2>
            <p>{template.id === 'fresh' ? t(M['ui.onboarding.fresh_hint']) : template.description}</p>
            <p>{t(M['ui.onboarding.includes'], { lists: template.lists.join(', ') || t(M['ui.onboarding.empty']) })}</p>
            {#if template.missing.length}<p>{t(M['ui.onboarding.unavailable'])}</p>{/if}
            <Button variant="secondary" disabled={busy || pendingApproval || template.missing.length > 0} onclick={() => change({ action: 'preview', id: template.id })}>{t(M['ui.onboarding.preview'], { name: template.id === 'fresh' ? t(M['ui.onboarding.fresh']) : template.name })}</Button>
          </Card>
        {/each}
      </div>
      {#if progress.preview}
        <section aria-label={t(M['ui.onboarding.review'])}>
          <h2 bind:this={reviewHeading} tabindex="-1">{t(M['ui.onboarding.review'])}</h2>
          <h3>{t(M['ui.onboarding.before'])}</h3><p>{progress.preview.before.join(', ') || t(M['ui.onboarding.empty'])}</p>
          <h3>{t(M['ui.onboarding.after'])}</h3><p>{progress.preview.after.join(', ') || t(M['ui.onboarding.empty'])}</p>
          <p>{t(M['ui.onboarding.retained'])}</p>
          {#if !progress.approvalId}
            <Button disabled={busy} onclick={() => change({ action: 'apply' })}>{t(M['ui.onboarding.apply'])}</Button>
          {/if}
        </section>
      {/if}
      {#if progress.approval}
        <section bind:this={decision} tabindex="-1" aria-label={t(M['ui.onboarding.pending'])}>
        <p>{t(M['ui.onboarding.pending'])}</p>
        {#key progress.approval.id}
          <AssistantApprovalCard approval={progress.approval} transport={approvalTransport} ondecided={refresh} />
        {/key}
        {#if ['denied', 'failed', 'expired'].includes(progress.approval.status)}
          <Button disabled={busy} onclick={() => change({ action: 'preview', id: progress.selected! })}>{t(M['ui.onboarding.retry'])}</Button>
        {/if}
        </section>
      {/if}
      <div class="smrt-first-run-onboarding__actions">
        {#if pendingApproval}
          <Button variant="ghost" href={backHref}>{t(M['ui.onboarding.back_settings'])}</Button>
        {:else if progress.rerunning}
          <Button variant="ghost" disabled={busy || pendingApproval} onclick={() => change({ action: 'cancel' })}>{t(M['ui.onboarding.cancel'])}</Button>
        {:else}
          <Button variant="ghost" disabled={busy || pendingApproval} onclick={() => change({ action: 'back' })}>{t(M['ui.onboarding.back'])}</Button>
        {/if}
      </div>
    {:else}
      <p>{t(M['ui.onboarding.restart_hint'])}</p>
      <Button disabled={busy} onclick={() => { confirming = true; }}>{t(M['ui.onboarding.restart'])}</Button>
      <Button variant="ghost" href={backHref}>{t(M['ui.onboarding.back_settings'])}</Button>
    {/if}
    {#if failed}
      <p bind:this={errorNotice} tabindex="-1" role="alert">{t(M['ui.onboarding.error'])}</p>
      <Button variant="secondary" disabled={busy} onclick={refresh}>{t(M['ui.onboarding.retry'])}</Button>
    {/if}
  </Card>
</div>
</main>
<ConfirmDialog open={confirming} title={t(M['ui.onboarding.restart'])} message={t(M['ui.onboarding.restart_hint'])} confirmLabel={t(M['ui.onboarding.continue'])} cancelLabel={t(M['ui.onboarding.cancel'])} oncancel={() => { confirming = false; }} onconfirm={() => { confirming = false; void change({ action: 'restart' }); }} />

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-first-run-onboarding__onboarding {
    inline-size: 100%;
    min-block-size: 100dvh;
    padding: var(--smrt-spacing-4);
    box-sizing: border-box;
  }
  .smrt-first-run-onboarding__onboarding-content {
    max-inline-size: calc(var(--smrt-spacing-24) * 10);
    margin-inline: auto;
  }
  .smrt-first-run-onboarding__templates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, calc(var(--smrt-spacing-16) * 4)), 1fr));
    gap: var(--smrt-spacing-3);
  }
  .smrt-first-run-onboarding__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    margin-block-start: var(--smrt-spacing-4);
  }
  section {
    margin-block: var(--smrt-spacing-4);
  }
}

@layer smrt.theme {
  .smrt-first-run-onboarding__onboarding {
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-background);
  }
  h1:focus {
    outline: none;
  }
  [role='alert'] {
    color: var(--smrt-color-error);
  }
}
</style>
