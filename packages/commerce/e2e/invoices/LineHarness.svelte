<script lang="ts">
import InvoiceLineEditor from '../../src/svelte/components/InvoiceLineEditor.svelte';
import { values } from './fixture.js';
let reported = $state('');
</script>
<div data-theme="material" data-color-scheme="light">
  <InvoiceLineEditor line={values.lines[0]} currency="CAD" inheritedTaxRate="5" onchange={line => { reported = `${line.quantity}:${line.taxMode}:${line.taxRate}`; }} />
  <output data-reported>{reported}</output>
  <output data-original>{values.lines[0].quantity}</output>
</div>
