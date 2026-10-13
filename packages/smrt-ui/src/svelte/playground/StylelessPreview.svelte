<script lang="ts">
import Alert from '../../components/feedback/Alert.svelte';
import Input from '../../components/forms/Input.svelte';
import Select from '../../components/forms/Select.svelte';
import Tabs from '../../components/nav/Tabs.svelte';
import Badge from '../../components/ui/Badge.svelte';
import Button from '../../components/ui/Button.svelte';
import Card from '../../components/ui/Card.svelte';
import Chip from '../../components/ui/Chip.svelte';
import unstyledCss from '../../styles/unstyled.css?inline';

// Native checkbox, outside the catalogue, so the toggle itself is never stripped.
let styleless = $state(false);
let active = $state('overview');

// Svelte does not interpolate text inside a style element, so the stylesheet is
// appended to the document head imperatively while the toggle is on.
$effect(() => {
  if (!styleless) return;
  const style = document.createElement('style');
  style.setAttribute('data-smrt-styleless', '');
  style.textContent = unstyledCss;
  document.head.appendChild(style);
  return () => style.remove();
});
const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];
</script>



<div class="workbench">
  <header>
    <div>
      <p class="eyebrow">Styleless mode</p>
      <h4>Layout kept, look removed</h4>
    </div>
    <label class="toggle">
      <input type="checkbox" bind:checked={styleless} />
      Apply unstyled.css
    </label>
  </header>

  <p class="note">
    With the toggle on, every component below keeps its layout and loses its
    themed look. The page chrome is not a smrt component, so it is unaffected.
  </p>

  <div class="catalogue">
    <section>
      <h5>Buttons and badges</h5>
      <div class="row">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Badge>Draft</Badge>
        <Chip label="Filter" />
      </div>
    </section>

    <section>
      <h5>Card</h5>
      <Card>
        {#snippet header()}<strong>Workspace</strong>{/snippet}
        <p>Card body text keeps its spacing and flow.</p>
        {#snippet footer()}<Button size="sm">Open</Button>{/snippet}
      </Card>
    </section>

    <section>
      <h5>Alert</h5>
      <Alert title="Information">The index refreshes in the background.</Alert>
    </section>

    <section>
      <h5>Form controls</h5>
      <div class="row">
        <Input name="styleless-name" placeholder="Name" />
        <Select name="styleless-role">
          <option value="owner">Owner</option>
          <option value="member">Member</option>
        </Select>
      </div>
    </section>

    <section>
      <h5>Tabs</h5>
      <Tabs {tabs} {active} onchange={(id) => (active = id)} />
    </section>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .workbench { display: grid; gap: var(--smrt-spacing-6); color: var(--smrt-color-on-surface); }
  header { display: flex; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); padding-bottom: var(--smrt-spacing-4); border-bottom: 1px solid var(--smrt-color-outline-variant); }
  h4, h5, p { margin: 0; }
  h4 { font: var(--smrt-typography-headline-small-font); }
  h5 { margin-bottom: var(--smrt-spacing-3); font: var(--smrt-typography-title-medium-font); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
  .note { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-body-medium-font); }
  .toggle { display: inline-flex; align-items: center; gap: var(--smrt-spacing-2); }
  .catalogue { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--smrt-spacing-5); }
  .catalogue > section { display: grid; align-content: start; gap: var(--smrt-spacing-2); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-3); }
}
</style>
