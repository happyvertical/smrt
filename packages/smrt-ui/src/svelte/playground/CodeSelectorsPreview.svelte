<script lang="ts">
import {
  CountrySelect,
  CurrencySelect,
  Form,
  FormGroup,
  ProvinceSelect,
} from '../../components/forms/index.js';
import Button from '../../components/ui/Button.svelte';

let currency = $state('CAD');
let country = $state('CA');
let province = $state('ON');
let submitted = $state('');
</script>
<div class="smrt-code-selectors-preview__root" data-smrt-component="CodeSelectorsPreview">
  <p>Localized country and currency choices. Province choices cover Canada and the United States; other countries accept free text. Changing country preserves the entered region for review.</p>
  <Form onsubmit={(event) => { submitted = JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))); }}>
    <FormGroup label="Currency"><CurrencySelect name="currency" bind:value={currency} /></FormGroup>
    <FormGroup label="Country"><CountrySelect name="country" bind:value={country} /></FormGroup>
    <FormGroup label="Province / state"><ProvinceSelect name="province" {country} bind:value={province} /></FormGroup>
    <Button type="submit">Inspect values</Button>
  </Form>
  <output aria-label="Submitted codes">{submitted}</output>
</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-code-selectors-preview__root {
    display: grid;
    gap: 1rem;
    max-width: 40rem;
  }
  output {
    overflow-wrap: anywhere;
  }
}

@layer smrt.theme {
  .smrt-code-selectors-preview__root {
    color: var(--smrt-color-on-surface);
  }
}

</style>
