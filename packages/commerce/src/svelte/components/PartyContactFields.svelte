<script lang="ts">
import { FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  PartyContactData,
  PartyContactLabels,
  PartyFieldNames,
} from '../party-types.js';
import { DEFAULT_PARTY_FIELD_NAMES } from '../party-types.js';

/** Props for the provider-free repeatable contact composition. */
export interface Props {
  /** Contact rows to display or submit in their given order. */
  contacts?: PartyContactData[];
  /** HTML field-name overrides used to preserve a caller's payload contract. */
  fieldNames?: Partial<PartyFieldNames>;
  /** Row-level validation errors returned by the server. */
  errors?: Array<Record<string, string | undefined> | undefined>;
  /** User-facing copy overrides for contact terminology. */
  labels?: PartyContactLabels;
  /** Renders contact values without editable controls or mutation actions. */
  readOnly?: boolean;
  /** Shows the native add-row submitter when editing. */
  canAdd?: boolean;
  /** Shows a native remove-row submitter for each contact when editing. */
  canRemove?: boolean;
  /** Name of the native submitter field used for row actions. */
  intentName?: string;
  /** Submitter value that asks the caller to append a row. */
  addIntent?: string;
  /** Produces the submitter value that asks the caller to remove one row. */
  removeIntent?: (index: number) => string;
}

const {
  contacts = [],
  fieldNames = {},
  errors = [],
  labels = {},
  readOnly = false,
  canAdd = true,
  canRemove = true,
  intentName = 'intent',
  addIntent = 'addContact',
  removeIntent = (index: number) => `removeContact:${index}`,
}: Props = $props();

const { t } = useI18n();
const instanceId = $props.id();
const headingId = `party-contacts-heading-${instanceId}`;
const names = $derived({ ...DEFAULT_PARTY_FIELD_NAMES, ...fieldNames });
const text = $derived({
  heading: labels.heading ?? t(M['commerce.party.contacts']),
  empty: labels.empty ?? t(M['commerce.party.no_contacts']),
  contact: labels.contact ?? t(M['commerce.party.contact']),
  name: labels.name ?? t(M['commerce.party.contact_name']),
  role: labels.role ?? t(M['commerce.party.contact_role']),
  email: labels.email ?? t(M['commerce.party.contact_email']),
  phone: labels.phone ?? t(M['commerce.party.contact_phone']),
  address: labels.address ?? t(M['commerce.party.contact_address']),
  add: labels.add ?? t(M['commerce.party.add_contact']),
  remove: labels.remove ?? t(M['commerce.party.remove_contact']),
});
</script>

<section class="smrt-party-contact-fields__root" aria-labelledby={headingId} data-smrt-component="PartyContactFields">
  {#if !readOnly}
    <!-- Presence marker: the server only treats zero posted rows as "remove all" when this block rendered. -->
    <Input interaction={false} type="hidden" name={names.contactCount} value={String(contacts.length)} />
  {/if}
  <div class="smrt-party-contact-fields__heading" data-smrt-part="header">
    <h2 id={headingId}>{text.heading}</h2>
    {#if !readOnly && canAdd}
      <Button
        type="submit"
        variant="secondary"
        name={intentName}
        value={addIntent}
        formnovalidate
      >{text.add}</Button>
    {/if}
  </div>

  {#if contacts.length === 0}
    <p class="smrt-party-contact-fields__empty" data-smrt-part="empty">{text.empty}</p>
  {:else}
    <div class="smrt-party-contact-fields__list" data-smrt-part="list">
      {#each contacts as contact, index (`${contact.id ?? 'new'}-${index}`)}
        {#if readOnly}
          <article class="smrt-party-contact-fields__card" data-smrt-part="item">
            <h3>{contact.name || `${text.contact} ${index + 1}`}</h3>
            {#if contact.label}<p>{contact.label}</p>{/if}
            {#if contact.email}<p><a href={`mailto:${contact.email}`}>{contact.email}</a></p>{/if}
            {#if contact.phone}<p><a href={`tel:${contact.phone}`}>{contact.phone}</a></p>{/if}
            {#if contact.address}<p class="smrt-party-contact-fields__address" data-smrt-part="body">{contact.address}</p>{/if}
          </article>
        {:else}
          <fieldset class="smrt-party-contact-fields__card" data-smrt-part="item">
            <legend>{text.contact} {index + 1}</legend>
            <Input interaction={false} type="hidden" name={names.contactId} value={contact.id ?? ''} />
            <div class="smrt-party-contact-fields__field-grid" data-smrt-part="group">
              <FormGroup label={text.name} error={errors[index]?.name}>
                <Input name={names.contactName} value={contact.name ?? ''} maxlength={160} />
              </FormGroup>
              <FormGroup label={text.role} error={errors[index]?.label}>
                <Input name={names.contactLabel} value={contact.label ?? ''} maxlength={80} />
              </FormGroup>
              <FormGroup label={text.email} error={errors[index]?.email}>
                <Input name={names.contactEmail} type="email" value={contact.email ?? ''} maxlength={320} />
              </FormGroup>
              <FormGroup label={text.phone} error={errors[index]?.phone}>
                <Input name={names.contactPhone} type="tel" value={contact.phone ?? ''} maxlength={80} />
              </FormGroup>
            </div>
            <FormGroup label={text.address} error={errors[index]?.address}>
              <Textarea name={names.contactAddress} value={contact.address ?? ''} rows={3} maxlength={500} />
            </FormGroup>
            {#if canRemove}
              <div class="smrt-party-contact-fields__actions" data-smrt-part="actions">
                <Button
                  type="submit"
                  variant="ghost"
                  name={intentName}
                  value={removeIntent(index)}
                  formnovalidate
                >{text.remove}</Button>
              </div>
            {/if}
          </fieldset>
        {/if}
      {/each}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-party-contact-fields__root {
    display: grid;
    gap: var(--smrt-spacing-4);
    min-inline-size: 0;
  }
  .smrt-party-contact-fields__heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
    flex-wrap: wrap;
  }
  h2, h3, p {
    margin: 0;
  }
  .smrt-party-contact-fields__list {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-party-contact-fields__card {
    min-inline-size: 0;
    margin: 0;
    padding: var(--smrt-spacing-4);
    overflow-wrap: anywhere;
  }
  article.smrt-party-contact-fields__card {
    display: grid;
    gap: var(--smrt-spacing-2);
  }
  .smrt-party-contact-fields__field-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 var(--smrt-spacing-4);
  }
  .smrt-party-contact-fields__field-grid :global([data-smrt-component="FormGroup"]) {
    min-inline-size: 0;
  }
  .smrt-party-contact-fields__actions {
    display: flex;
    justify-content: flex-end;
  }
  .smrt-party-contact-fields__address {
    white-space: pre-wrap;
  }
  @media (max-width: 30rem) {
    .smrt-party-contact-fields__field-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .smrt-party-contact-fields__card {
      padding: var(--smrt-spacing-3);
    }
  }
}

@layer smrt.theme {
  h2 {
    font: var(--smrt-typography-title-large-font);
    color: var(--smrt-color-on-surface);
  }
  h3, legend {
    font: var(--smrt-typography-title-medium-font);
    color: var(--smrt-color-on-surface);
  }
  .smrt-party-contact-fields__card {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-party-contact-fields__empty {
    color: var(--smrt-color-on-surface-variant);
  }
  a {
    color: var(--smrt-color-primary);
  }
}

</style>
