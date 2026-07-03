<script lang="ts">
import {
  ActivityList,
  ActivityToasts,
  AdminShell,
  AppScopePanel,
  createShellState,
  type ShellNavItem,
  type ShellStatusChip,
  type ShellSystemPanel,
  SystemScopePanel,
  SystemStatusChips,
  TenantNav,
} from '@happyvertical/smrt-svelte/workspace';
import { Button } from '@happyvertical/smrt-ui';
import { onDestroy, onMount } from 'svelte';

const subject = {
  type: 'scene',
  id: 'scene-42',
  label: 'Scene 42',
};

const shell = createShellState({
  config: {
    top: { exclusiveGroup: 'vertical' },
    bottom: { exclusiveGroup: 'vertical' },
  },
  settings: {
    panels: {
      left: 'expanded',
      right: 'expanded',
    },
  },
});

const tenantItems: ShellNavItem[] = [
  {
    href: '/admin/content',
    label: 'Content',
    icon: 'C',
    children: [
      { href: '/admin/content/articles', label: 'Articles', badge: 12 },
      { href: '/admin/content/media', label: 'Media' },
    ],
  },
  {
    href: '/admin/operations',
    label: 'Operations',
    icon: 'O',
    children: [
      { href: '/admin/operations/jobs', label: 'Jobs', badge: 3 },
      { href: '/admin/operations/dispatch', label: 'Dispatch' },
    ],
  },
];

const statusChips: ShellStatusChip[] = [
  { id: 'env', label: 'Local', tone: 'info' },
  { id: 'jobs', label: 'Jobs', value: 3, tone: 'warning' },
  { id: 'dispatch', label: 'Dispatch', value: 18, tone: 'success' },
  { id: 'connection', label: 'Connected', tone: 'success' },
];

const systemPanels: ShellSystemPanel[] = [
  {
    id: 'jobs',
    label: 'Jobs',
    items: [
      {
        id: 'job-1',
        label: 'Knowledge rebuild',
        status: 'running',
        detail: 'Started by playground fixture',
      },
      {
        id: 'job-2',
        label: 'Thumbnail sync',
        status: 'queued',
        detail: 'Waiting for worker',
      },
    ],
  },
  {
    id: 'dispatch',
    label: 'Dispatch',
    items: [
      {
        id: 'dispatch-1',
        label: 'agent.video.encode',
        status: 'pending',
        detail: 'Subscriber: video-worker',
      },
    ],
  },
];

let cleanup: Array<() => void> = [];
let encodeStep = $state(0);

onMount(() => {
  cleanup = [
    shell.registerFocusTool({
      id: 'inspector',
      label: 'Inspector',
      order: 1,
      subject,
    }),
    shell.registerFocusTool({
      id: 'encodes',
      label: 'Encodes',
      order: 2,
      subject,
      activityKinds: ['video-encode'],
    }),
  ];
});

onDestroy(() => {
  for (const fn of cleanup) {
    fn();
  }
});

function startEncode() {
  encodeStep += 1;
  shell.upsertActivity({
    id: `encode-${encodeStep}`,
    label: `Video encode ${encodeStep}`,
    kind: 'video-encode',
    scope: 'focus',
    subject,
    status: 'running',
    progress: 32,
    message: 'Rendering preview frames',
  });
  shell.openFocusTool('encodes');
}

function completeLatest() {
  const latest = shell
    .listActivities({ kind: 'video-encode', status: 'running' })
    .at(-1);
  if (latest) {
    shell.updateActivity(latest.id, {
      status: 'completed',
      progress: 100,
      message: 'Ready for review',
    });
  }
}
</script>

<AdminShell
  title="SMRT AdminShell"
  subtitle="Playground"
  state={shell}
>
  {#snippet appPanel()}
    <AppScopePanel
      appName="SMRT Playground"
      tenantName="Demo tenant"
      environment="local"
    />
  {/snippet}

  {#snippet tenantPanel()}
    <TenantNav items={tenantItems} currentHref="/admin/operations/jobs" />
  {/snippet}

  {#snippet systemBar()}
    <SystemStatusChips chips={statusChips} />
  {/snippet}

  {#snippet systemPanel()}
    <SystemScopePanel panels={systemPanels} />
  {/snippet}

  {#snippet focusPanel()}
    <section class="admin-shell-focus">
      <header>
        <h2>Focus tools</h2>
      </header>
      <div class="tool-switcher">
        {#each shell.focusTools as tool (tool.id)}
          <Button
            variant={shell.activeFocusToolId === tool.id ? 'primary' : 'secondary'}
            size="sm"
            onclick={() => shell.openFocusTool(tool.id)}
          >
            {tool.label}
          </Button>
        {/each}
      </div>

      {#if shell.activeFocusToolId === 'encodes'}
        <div class="focus-block">
          <h3>Video encodes</h3>
          <div class="tool-actions">
            <Button size="sm" onclick={startEncode}>Start encode</Button>
            <Button variant="secondary" size="sm" onclick={completeLatest}>
              Complete latest
            </Button>
          </div>
          <ActivityList
            filter={{ kind: 'video-encode', subject }}
            hideWhenEmpty
          />
        </div>
      {:else}
        <div class="focus-block">
          <h3>{subject.label}</h3>
          <p>Selected record metadata and actions live beside the workspace.</p>
        </div>
      {/if}
    </section>
  {/snippet}

  <section class="admin-shell-workspace">
    <header>
      <h1>Operations workbench</h1>
      <p>
        Four shell edges stay available while the workspace body remains focused
        on the current record.
      </p>
      <div class="tool-actions">
        <Button onclick={startEncode}>Start video encode</Button>
        <Button variant="secondary" onclick={() => shell.togglePanel('bottom')}>
          Toggle system
        </Button>
      </div>
    </header>

    <div class="workspace-grid">
      <section>
        <span>Queue</span>
        <strong>3</strong>
      </section>
      <section>
        <span>Dispatch</span>
        <strong>18</strong>
      </section>
      <section>
        <span>Focus activities</span>
        <strong>{shell.listActivities({ scope: 'focus' }).length}</strong>
      </section>
    </div>
  </section>

  <ActivityToasts />
</AdminShell>

<style>
  :global(body) {
    margin: 0;
  }

  .admin-shell-workspace {
    display: grid;
    gap: var(--smrt-spacing-6);
    min-block-size: 100%;
    padding: var(--smrt-spacing-8);
    background: var(--smrt-color-surface);
  }

  .admin-shell-workspace header,
  .admin-shell-focus,
  .focus-block {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .admin-shell-workspace h1,
  .admin-shell-workspace p,
  .admin-shell-focus h2,
  .admin-shell-focus h3,
  .focus-block p {
    margin: 0;
  }

  .admin-shell-workspace p,
  .focus-block p {
    color: var(--smrt-color-on-surface-variant);
  }

  .tool-actions,
  .tool-switcher {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2);
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--smrt-spacing-4);
  }

  .workspace-grid section {
    display: grid;
    gap: var(--smrt-spacing-2);
    padding-block: var(--smrt-spacing-4);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .workspace-grid span {
    color: var(--smrt-color-on-surface-variant);
  }

  .workspace-grid strong {
    font-size: var(--smrt-typography-headline-medium-size);
  }
</style>
