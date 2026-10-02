<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellActivity } from './types.js';

interface Props {
  /** Authenticated app-owned activities; this component never fetches process data. */
  activities: ReadonlyArray<ShellActivity>;
  /** Accessible region name. */
  label?: string;
  /** Message shown when no activities are running. */
  emptyLabel?: string;
}
let { activities, label, emptyLabel }: Props = $props();
const { t } = useI18n();
let paused = $state(false);
const running = $derived(
  activities.filter((activity) => activity.status === 'running'),
);
const multiple = $derived(running.length > 1);
function progress(activity: ShellActivity): string {
  return typeof activity.progress === 'number' &&
    Number.isFinite(activity.progress) &&
    activity.progress >= 0 &&
    activity.progress <= 100
    ? ` · ${Math.round(activity.progress)}%`
    : '';
}
</script>

<div class="smrt-activity-ticker-shell">
<div class="smrt-activity-ticker" class:multiple class:paused role="region" aria-label={label ?? t(M['ui.activity_ticker.label'])} style:--activity-ticker-duration={`${Math.max(20, running.length * 10)}s`}>
  {#if running.length === 0}
    <span class="smrt-activity-ticker__empty">{emptyLabel ?? t(M['ui.activity_ticker.empty'])}</span>
  {:else}
    <ul class="smrt-activity-ticker__accessible">
      {#each running as activity (activity.id)}<li>{activity.label}{progress(activity)}</li>{/each}
    </ul>
    <div class="smrt-activity-ticker__track" aria-hidden="true">
      <span class="smrt-activity-ticker__group">
        {#each running as activity (activity.id)}<span>{activity.label}{progress(activity)}</span>{/each}
      </span>
      {#if multiple}
        <span class="smrt-activity-ticker__group smrt-activity-ticker__copy">
          {#each running as activity (activity.id)}<span>{activity.label}{progress(activity)}</span>{/each}
        </span>
      {/if}
    </div>
  {/if}
</div>
{#if multiple}
  <span class="smrt-activity-ticker__control">
    <Button variant="ghost" size="sm" aria-label={t(paused ? M['ui.activity_ticker.resume'] : M['ui.activity_ticker.pause'])} title={t(paused ? M['ui.activity_ticker.resume'] : M['ui.activity_ticker.pause'])} onclick={() => paused = !paused}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        {#if paused}<path d="M4 2v12l10-6z" />{:else}<path d="M3 2h4v12H3zM9 2h4v12H9z" />{/if}
      </svg>
    </Button>
  </span>
{/if}
</div>

<style>
.smrt-activity-ticker-shell { display:flex; align-items:center; flex:1; min-width:0; gap:var(--smrt-spacing-2); }
.smrt-activity-ticker { flex:1; min-width:0; overflow:hidden; color:var(--smrt-color-on-surface-variant); font-size:var(--smrt-typography-body-small-size); white-space:nowrap; }
.smrt-activity-ticker__track { display:flex; width:max-content; }
.smrt-activity-ticker__group { display:flex; gap:var(--smrt-spacing-6); flex-shrink:0; }
.multiple .smrt-activity-ticker__group { padding-inline-end:var(--smrt-spacing-6); }
.multiple .smrt-activity-ticker__track { animation:smrt-activity-scroll var(--activity-ticker-duration) linear infinite; }
.smrt-activity-ticker.paused .smrt-activity-ticker__track,
.smrt-activity-ticker:hover .smrt-activity-ticker__track,
.smrt-activity-ticker-shell:focus-within .smrt-activity-ticker__track { animation-play-state:paused; }
.smrt-activity-ticker__accessible { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:normal; }
@keyframes smrt-activity-scroll { to { transform:translateX(-50%); } }
@media (prefers-reduced-motion:reduce) {
  .smrt-activity-ticker { overflow-x:auto; }
  .multiple .smrt-activity-ticker__track { animation:none; }
  .smrt-activity-ticker__copy, .smrt-activity-ticker__control { display:none; }
}
</style>
