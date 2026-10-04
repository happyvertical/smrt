<script lang="ts">
import { Form, FormGroup, CurrencySelect, CountrySelect, ProvinceSelect } from '../src/components/forms/index.js';
import Button from '../src/components/ui/Button.svelte';
let currency = $state('');
let country = $state('CA');
let province = $state('ON');
let result = $state('');
</script>
<Form id="codes" onsubmit={(event) => result = JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))}>
<FormGroup label="Currency"><CurrencySelect name="currency" required bind:value={currency} /></FormGroup>
<FormGroup label="Country"><CountrySelect name="country" bind:value={country} /></FormGroup>
<FormGroup label="Province"><ProvinceSelect name="province" {country} bind:value={province} /></FormGroup>
<FormGroup label="Disabled choice"><CurrencySelect name="disabledChoice" value="CAD" options={[{value:'CAD',disabled:true}]} /></FormGroup>
<Button type="submit">Submit</Button><Button type="reset">Reset</Button>
</Form>
<FormGroup label="Retained"><CurrencySelect name="retained" form="codes" readOnly value=" raw " /></FormGroup>
<output aria-label="Result">{result}</output>
