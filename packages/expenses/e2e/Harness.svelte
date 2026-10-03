<script lang="ts">
import ExpenseForm from '../src/svelte/components/ExpenseForm.svelte';
import { values } from './fixture.js';
</script>
<div data-theme="material" data-color-scheme="light">
  <ExpenseForm action="/save" {values} correcting hiddenFields={[{ name: 'requestId', value: 'same-request' }, { name: 'tenantId', value: 'same-tenant' }, { name: 'predecessorId', value: 'same-predecessor' }]} />
</div>
