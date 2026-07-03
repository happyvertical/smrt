<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import type { ShellActivity } from './types.js';

interface Props {
  activity: ShellActivity;
}

let { activity }: Props = $props();
const { t } = useI18n();
</script>

<article class="smrt-activity-item" data-status={activity.status}>
  <div class="smrt-activity-item__main">
    <strong>{activity.label}</strong>
    <span>{activity.status}</span>
    {#if activity.message}
      <p>{activity.message}</p>
    {/if}
    {#if typeof activity.progress === 'number'}
      <progress max="100" value={activity.progress}>
        {Math.round(activity.progress)}%
      </progress>
    {/if}
  </div>
  <div class="smrt-activity-item__actions">
    {#if activity.detailHref}
      <Button variant="ghost" size="sm" href={activity.detailHref}>
        {t(M['ui.activity_item.view'])}
      </Button>
    {/if}
    {#if activity.cancel && (activity.status === 'queued' || activity.status === 'running')}
      <Button variant="ghost" size="sm" onclick={() => activity.cancel?.()}>
        {t(M['ui.activity_item.cancel'])}
      </Button>
    {/if}
  </div>
</article>

<style>
  .smrt-activity-item {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    padding: var(--smrt-spacing-3) 0;
    border-block-end: 1px solid var(--smrt-color-outline-variant);
  }

  .smrt-activity-item__main {
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .smrt-activity-item strong,
  .smrt-activity-item span,
  .smrt-activity-item p {
    overflow-wrap: anywhere;
  }

  .smrt-activity-item span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size);
    text-transform: uppercase;
  }

  .smrt-activity-item p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-activity-item progress {
    width: min(16rem, 100%);
  }

  .smrt-activity-item__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
    justify-content: flex-end;
  }
</style>
