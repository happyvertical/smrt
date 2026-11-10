<script lang="ts">
import { cookbookStore } from '../cookbook/store.svelte.ts';

/**
 * The Specs tab: the visitor's own product requirements, beyond what the
 * chosen features cover. Saved in the cookbook (`specs`) and carried into the
 * build prompt, so each keystroke goes straight through `setSpecs`.
 */
const LIMIT = 20000;
// The store trims trailing whitespace, so the textarea keeps its own draft:
// a typed space or new line at the end must not vanish mid-typing. Outside
// changes (an import, an assistant append) replace the draft.
let value = $state(cookbookStore.specs ?? '');
$effect(() => {
  const saved = cookbookStore.specs ?? '';
  if (saved !== value.trimEnd()) value = saved;
});
const count = $derived(Array.from(value).length);
</script>

<section class="specs" aria-labelledby="planner-specs-heading">
  <h2 id="planner-specs-heading">Specs</h2>
  <p id="planner-specs-help" class="help">
    What your app must also do beyond its features: unique rules, workflows,
    integrations. They go into your build prompt and exported cookbook.
  </p>
  <textarea
    id="planner-specs-input"
    aria-labelledby="planner-specs-heading"
    {value}
    maxlength={LIMIT}
    rows="14"
    aria-describedby="planner-specs-help planner-specs-count"
    placeholder={'Examples:\n- Customers can only book a class if their waiver is signed.\n- Send a Slack message when an order over $500 is paid.\n- Staff see their own schedule; managers see everyone\'s.'}
    oninput={(event) => {
      value = event.currentTarget.value;
      cookbookStore.setSpecs(value);
    }}
  ></textarea>
  <p id="planner-specs-count" class="count">{count.toLocaleString('en-US')} / {LIMIT.toLocaleString('en-US')}</p>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .specs { display: grid; gap: var(--smrt-spacing-3); max-inline-size: 48rem; }
  h2, .help, .count { margin: 0; }
  .help { color: var(--smrt-color-on-surface-variant); }
  textarea { box-sizing: border-box; inline-size: 100%; min-block-size: 16rem; padding: var(--smrt-spacing-3); border: var(--smrt-control-border); border-radius: var(--smrt-radius-large, 0.75rem); background: var(--smrt-surface-control); color: var(--smrt-color-on-surface); font: inherit; line-height: 1.5; resize: vertical; }
  textarea:focus-visible { outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color); outline-offset: var(--smrt-focus-ring-offset); }
  textarea::placeholder { color: var(--smrt-color-on-surface-variant); }
  .count { justify-self: end; color: var(--smrt-color-on-surface-variant); font-size: 0.875rem; }
}
</style>
