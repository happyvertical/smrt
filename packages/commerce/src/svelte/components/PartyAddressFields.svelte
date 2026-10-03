<script lang="ts">
import { FormGroup, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { PartyAddressData } from '../party-types.js';

export interface AddressFieldNames {
  street1: string;
  street2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface Props {
  heading: string;
  value?: PartyAddressData;
  names: AddressFieldNames;
  errors?: Record<string, string | undefined>;
  readOnly?: boolean;
}

const {
  heading,
  value = {},
  names,
  errors = {},
  readOnly = false,
}: Props = $props();
const { t } = useI18n();
</script>

<fieldset class="address-fields">
  <legend>{heading}</legend>
  <FormGroup label={t(M['commerce.party.street_address'])} error={errors.street1}>
    <Input name={names.street1} value={value.street1 ?? ''} maxlength={160} readonly={readOnly} />
  </FormGroup>
  <FormGroup label={t(M['commerce.party.address_line_2'])} error={errors.street2}>
    <Input name={names.street2} value={value.street2 ?? ''} maxlength={160} readonly={readOnly} />
  </FormGroup>
  <div class="address-grid">
    <FormGroup label={t(M['commerce.party.city'])} error={errors.city}>
      <Input name={names.city} value={value.city ?? ''} maxlength={100} readonly={readOnly} />
    </FormGroup>
    <FormGroup label={t(M['commerce.party.state'])} error={errors.state}>
      <Input name={names.state} value={value.state ?? ''} maxlength={100} readonly={readOnly} />
    </FormGroup>
    <FormGroup label={t(M['commerce.party.postal_code'])} error={errors.postalCode}>
      <Input name={names.postalCode} value={value.postalCode ?? ''} maxlength={32} readonly={readOnly} />
    </FormGroup>
    <FormGroup label={t(M['commerce.party.country'])} error={errors.country}>
      <Input name={names.country} value={value.country ?? ''} maxlength={100} readonly={readOnly} />
    </FormGroup>
  </div>
</fieldset>

<style>
  .address-fields { min-inline-size: 0; margin: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); }
  legend { padding-inline: var(--smrt-spacing-2); font: var(--smrt-typography-title-medium-font); color: var(--smrt-color-on-surface); }
  .address-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--smrt-spacing-4); }
  @media (max-width: 30rem) { .address-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
