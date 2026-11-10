<script lang="ts">
import DocumentViewer from '../../components/display/DocumentViewer.svelte';
import NumericKeypad from '../../components/forms/NumericKeypad.svelte';
import type { NumericKeypadDetail } from '../../components/forms/numeric-keypad-logic.js';

let quantity = $state('');
let amount = $state('');
let lastMoney = $state<NumericKeypadDetail | null>(null);

// A drawn sheet served from memory, so the preview needs no network or pdf.js.
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000" viewBox="0 0 800 1000"><rect width="800" height="1000" fill="#fff"/><rect x="40" y="40" width="720" height="920" fill="none" stroke="#111" stroke-width="4"/><text x="80" y="130" font-family="sans-serif" font-size="48" fill="#111">Sample shop print</text><path d="M80 220h640M80 300h440M80 380h560M80 460h300" stroke="#555" stroke-width="6"/></svg>`;
const previewFetch: typeof fetch = async () =>
  new Response(sheet, { headers: { 'content-type': 'image/svg+xml' } });
</script>

<div class="workbench">
  <header>
    <p class="eyebrow">Touch density</p>
    <h4>Keypad and document viewer</h4>
    <p>Every key and control is at least 4rem. Money is carried as integer minor units; the viewer reads through an injected fetch and never points an element at the API.</p>
  </header>
  <section>
    <h5>Quantity</h5>
    <NumericKeypad bind:value={quantity} min={1} max={500} unit="pcs" />
  </section>
  <section>
    <h5>Money (USD)</h5>
    <NumericKeypad bind:value={amount} mode="money" currency="USD" prefix="$" onChange={(detail) => (lastMoney = detail)} onSubmit={(detail) => (lastMoney = detail)} />
    <p class="posted" role="status">{lastMoney?.minorUnits == null ? 'Type an amount.' : `${lastMoney.minorUnits} minor units`}</p>
  </section>
  <section>
    <h5>Document</h5>
    <DocumentViewer src="/preview/sheet.svg" mimeType="image/svg+xml" label="Sample shop print" fetch={previewFetch} />
  </section>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .workbench { display: grid; gap: var(--smrt-spacing-5); color: var(--smrt-color-on-surface); }
  header, section { display: grid; gap: var(--smrt-spacing-3); min-width: 0; }
  h4, h5, p { margin: 0; } h4 { font: var(--smrt-typography-headline-small-font); }
  h5 { font: var(--smrt-typography-title-medium-font); }
  header p:not(.eyebrow), .posted { color: var(--smrt-color-on-surface-variant); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
}
</style>
