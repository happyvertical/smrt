<script lang="ts">
import { useLinkSurface } from '../link-surface.svelte.js';
import { useListSurface } from '../list-surface.svelte.js';
import { useStepSurface } from '../step-surface.svelte.js';
import { tryUseWebMcpUi } from '../webmcp-ui-context.js';

let {
  rows,
  step = $bindable('town'),
  navigate,
  onContext,
  create,
}: {
  rows: Array<{ id: string; title: string; status: string; token: string }>;
  step?: string;
  navigate: (href: string) => void;
  onContext?: (enabled: boolean) => void;
  create: () => void;
} = $props();

onContext?.(tryUseWebMcpUi() !== null);

useListSurface(() => ({
  surfaceId: 'articles-ui',
  label: 'Articles',
  description: 'Articles on this page',
  columns: [
    { id: 'id', label: 'ID', rowKey: true },
    { id: 'title', label: 'Title', searchable: true },
    { id: 'status', label: 'Status', status: true },
  ],
  rows,
  maxRows: 2,
}));

useLinkSurface(() => ({
  surfaceId: 'site-sections-ui',
  label: 'Site sections',
  description: 'Pages in this site',
  links: [
    { id: 'events', label: 'Events', href: '/s/events' },
    { id: 'articles', label: 'Articles', href: '/s/articles' },
  ],
  navigate,
  state: { active: 'articles' },
}));

useStepSurface(() => ({
  surfaceId: 'new-site-steps',
  label: 'New site',
  description: 'Start a new town site',
  steps: [
    { id: 'town', label: 'Your town', complete: step !== 'town' },
    { id: 'features', label: 'Features' },
  ],
  current: step,
  next: () => {
    step = 'features';
  },
  nextWrites: step === 'features',
  showNext: () => document.getElementById('create')?.focus(),
  back: () => {
    step = 'town';
  },
}));
</script>

<p data-testid="step">{step}</p>
<button id="create" type="button" onclick={create}>Create site</button>
