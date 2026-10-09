<script lang="ts" generics="T extends CustomerDisplayData | VendorDisplayData">
import {
  type ControlInteractionOptions,
  RelationInput,
  type RelationOption,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { CustomerDisplayData, VendorDisplayData } from '../party-types.js';

/**
 * Shared adapter behind `CustomerSelect` and `VendorSelect`: maps party DTOs to
 * the smrt-ui `RelationInput` and localizes its text. Presentation only: the
 * caller owns `search`, `resolve` and `onCreate`, so the lookup an assistant
 * uses to turn a name into a record id also backs the field.
 */
export interface Props<Party> {
  /** Which party this picks; selects the default label, hints and detail line. */
  kind: 'customer' | 'vendor';
  /** Field name; the selected id posts under it. */
  name: string;
  /** Selected record id (bindable). Empty string means no selection. */
  value?: string;
  /** Visible label. Defaults to the localized party name. */
  label?: string;
  /** Required field: hides the clear button. */
  required?: boolean;
  /** Disabled state. */
  disabled?: boolean;
  /** Validation error shown below the field. */
  error?: string;
  /** Placeholder shown while nothing is selected. */
  placeholder?: string;
  /** Hint announced with the field. */
  description?: string;
  /** Caller-owned lookup; called with '' when the list opens. */
  search: (query: string) => Promise<Party[]>;
  /** Caller-owned lookup of the current value when it has not been listed yet. */
  resolve?: (id: string) => Promise<Party | null>;
  /**
   * "New ..." action, offered only when supplied. Receives the text most
   * recently searched for; a returned record is selected.
   */
  onCreate?: (query: string) => void | Party | Promise<void | Party>;
  /** Text for the "New ..." button. */
  createLabel?: string;
  /** Milliseconds to wait after typing before searching. */
  debounceMs?: number;
  /** Combobox interaction options for agents, or false to opt out. */
  interaction?: ControlInteractionOptions | false;
  /** Called when the selected id changes ('' when cleared). */
  onchange?: (id: string) => void;
}

let {
  kind,
  value = $bindable(''),
  label,
  placeholder,
  createLabel,
  search,
  resolve,
  onCreate,
  ...rest
}: Props<T> = $props();

const { t } = useI18n();

const singular = $derived(
  t(
    kind === 'customer'
      ? M['commerce.customer.singular']
      : M['commerce.vendor.singular'],
  ),
);
const fieldLabel = $derived(label ?? singular);

function statusLabel(status: string): string {
  if (status === 'active') return t(M['commerce.party.status_active']);
  if (status === 'inactive') return t(M['commerce.party.status_inactive']);
  if (status === 'suspended') return t(M['commerce.party.status_suspended']);
  return status;
}

function typeLabel(type: string): string {
  if (type === 'dtc') return t(M['commerce.customer.type_dtc']);
  if (type === 'wholesale') return t(M['commerce.customer.type_wholesale']);
  if (type === 'retail') return t(M['commerce.customer.type_retail']);
  return type;
}

/** A party as a list row: the profile name, with status (and type) beneath. */
function toOption(
  party: CustomerDisplayData | VendorDisplayData,
): RelationOption {
  const type = 'customerType' in party ? party.customerType : undefined;
  const detail = [
    party.status ? statusLabel(party.status) : '',
    type ? typeLabel(type) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: party.id,
    label: party.profile.name,
    ...(detail ? { detail } : {}),
  };
}
</script>

<RelationInput
  {...rest}
  bind:value
  label={fieldLabel}
  placeholder={placeholder ??
    t(kind === 'customer' ? M['commerce.customer.search'] : M['commerce.vendor.search'])}
  createLabel={createLabel ??
    t(kind === 'customer' ? M['commerce.select.new_customer'] : M['commerce.select.new_vendor'])}
  clearLabel={t(M['commerce.select.clear'], { label: fieldLabel })}
  loadingText={t(M['commerce.select.searching'])}
  emptyText={t(M['commerce.select.no_matches'])}
  errorText={t(M['commerce.select.search_failed'])}
  resultsText={(count) =>
    t(count === 1 ? M['commerce.select.results_one'] : M['commerce.select.results_other'], { count })}
  search={async (query) => (await search(query)).map(toOption)}
  resolve={resolve
    ? async (id) => {
        const found = await resolve(id);
        return found ? { id: found.id, label: found.profile.name } : null;
      }
    : undefined}
  onCreate={onCreate
    ? async (query) => {
        const made = await onCreate(query);
        return made && typeof made === 'object' ? toOption(made) : undefined;
      }
    : undefined}
/>
