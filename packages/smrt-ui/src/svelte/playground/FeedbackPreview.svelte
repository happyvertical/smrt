<script lang="ts">
import Alert from '../../components/feedback/Alert.svelte';
import Drawer from '../../components/feedback/Drawer.svelte';
import Meter from '../../components/feedback/Meter.svelte';
import Progress from '../../components/feedback/Progress.svelte';
import Spinner from '../../components/feedback/Spinner.svelte';
import ToastViewport from '../../components/feedback/ToastViewport.svelte';
import { createToaster } from '../../components/feedback/toast.js';
import Accordion from '../../components/ui/Accordion.svelte';
import AccordionItem from '../../components/ui/AccordionItem.svelte';
import Button from '../../components/ui/Button.svelte';
import Disclosure from '../../components/ui/Disclosure.svelte';
import Dropdown from '../../components/ui/Dropdown.svelte';
import Popover from '../../components/ui/Popover.svelte';

const toaster = createToaster();
let progress = $state(42);
let drawerOpen = $state(false);
const menu = [
  { id: 'edit', label: 'Edit' },
  { id: 'duplicate', label: 'Duplicate' },
  { id: 'archive', label: 'Archive' },
];
</script>

<div class="workbench">
  <header><div><p class="eyebrow">Feedback and disclosure</p><h4>Status, progress, overlays, and layered interaction</h4></div><div class="actions"><Button size="sm" onclick={() => toaster.success('Settings saved', { duration: 0 })}>Show toast</Button><Button size="sm" variant="secondary" onclick={() => drawerOpen = true}>Open drawer</Button></div></header>

  <section><h5>Alerts</h5><div class="stack"><Alert title="Information">The index will refresh in the background.</Alert><Alert variant="success" title="Published">Your changes are live.</Alert><Alert variant="warning" title="Review needed">Two fields use inherited defaults.</Alert><Alert variant="error" title="Connection lost" dismissible>Reconnect before submitting.</Alert></div></section>

  <section><h5>Progress and measurement</h5><div class="progress-grid"><div><span>Determinate</span><Progress label="Upload progress" value={progress} showValue /></div><div><span>Indeterminate</span><Progress label="Preparing files" /></div><div><span>Circular</span><Progress label="Analysis progress" value={68} variant="circular" showValue /></div><div><span>Meter</span><Meter label="Storage used" value={72} low={45} high={80} optimum={25} showValue /></div><Spinner label="Synchronizing" /></div></section>

  <section><h5>Layered interaction</h5><div class="interaction-row"><Popover label="Filter options"><strong>Quick filters</strong><p>Use a popover for lightweight contextual controls.</p></Popover><Dropdown label="Actions" items={menu} /><Disclosure title="Disclosure details"><p>Native details semantics for independent content.</p></Disclosure></div><Accordion><AccordionItem value="behavior" title="Behavior"><p>Single-open accordion by default.</p></AccordionItem><AccordionItem value="accessibility" title="Accessibility"><p>Keyboard controls, labelled regions, and reduced-motion support.</p></AccordionItem></Accordion></section>

  <div class="slider"><label for="progress-demo">Progress value <output>{progress}%</output></label><input id="progress-demo" type="range" min="0" max="100" bind:value={progress} /></div>
  <ToastViewport {toaster} />
  <Drawer bind:open={drawerOpen} title="Workspace details"><p>Drawers share the modal focus and dismissal contract.</p>{#snippet footer()}<Button onclick={() => drawerOpen = false}>Done</Button>{/snippet}</Drawer>
</div>

<style>
  .workbench { display: grid; gap: var(--smrt-spacing-6); color: var(--smrt-color-on-surface); }
  header, .actions, .interaction-row { display: flex; align-items: center; gap: var(--smrt-spacing-3); } header { justify-content: space-between; padding-bottom: var(--smrt-spacing-4); border-bottom: 1px solid var(--smrt-color-outline-variant); }
  h4, h5, p { margin: 0; } h4 { font: var(--smrt-typography-headline-small-font); } h5 { margin-bottom: var(--smrt-spacing-3); font: var(--smrt-typography-title-medium-font); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
  .stack { display: grid; gap: var(--smrt-spacing-2); }
  .progress-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-5); align-items: center; }
  .progress-grid > div { display: grid; gap: var(--smrt-spacing-2); } .progress-grid span, .slider label { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-medium-font); }
  .interaction-row { flex-wrap: wrap; align-items: flex-start; margin-bottom: var(--smrt-spacing-3); }
  .slider { display: grid; max-width: 24rem; gap: var(--smrt-spacing-2); } .slider label { display: flex; justify-content: space-between; } input { accent-color: var(--smrt-color-primary); }
  @media (max-width: 760px) { header { align-items: flex-start; flex-direction: column; } .progress-grid { grid-template-columns: 1fr; } }
</style>
