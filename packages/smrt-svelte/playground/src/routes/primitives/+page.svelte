<script lang="ts">
import { Avatar, Chip, Skeleton } from '@happyvertical/smrt-svelte';

let selected = $state<Record<string, boolean>>({ ts: true, svelte: false });
let chips = $state(['Design', 'A11y', 'Tokens']);

function toggle(key: string) {
  selected[key] = !selected[key];
}
function removeChip(name: string) {
  chips = chips.filter((c) => c !== name);
}
</script>

<h1>Gap Primitives</h1>
<p class="description">
  Generic library primitives (L3 #1422) — Avatar, Chip, Skeleton.
</p>

<section>
  <h2>Avatar</h2>
  <p class="section-desc">Image with initials fallback + optional presence dot.</p>
  <div class="demo-row">
    <Avatar name="Ada Lovelace" size="sm" />
    <Avatar name="Grace Hopper" size="md" status="online" />
    <Avatar name="Linus Torvalds" size="lg" status="busy" />
    <Avatar name="Margaret Hamilton" size="xl" status="away" />
  </div>
</section>

<section>
  <h2>Chip</h2>
  <p class="section-desc">Selectable toggles and closeable tokens.</p>
  <div class="demo-row">
    <Chip
      label="TypeScript"
      selectable
      selected={selected.ts}
      onselect={() => toggle('ts')}
    />
    <Chip
      label="Svelte"
      selectable
      selected={selected.svelte}
      onselect={() => toggle('svelte')}
    />
  </div>
  <div class="demo-row">
    {#each chips as chip (chip)}
      <Chip label={chip} closeable onclose={() => removeChip(chip)} />
    {/each}
  </div>
</section>

<section>
  <h2>Skeleton</h2>
  <p class="section-desc">Shape-matching loading placeholders.</p>
  <div class="demo-row" style="align-items: center; gap: 16px;">
    <Skeleton variant="circle" />
    <div style="flex: 1;">
      <Skeleton variant="text" lines={3} />
    </div>
  </div>
  <div class="demo-row">
    <Skeleton variant="rect" width="240px" height="120px" />
  </div>
</section>

<style>
  .description {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    margin-bottom: 2rem;
  }
  section {
    margin-bottom: 2.5rem;
  }
  .section-desc {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }
  .demo-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 0.75rem;
  }
</style>
