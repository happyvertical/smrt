<script lang="ts">
import type { ControlInteractionOptions } from '@happyvertical/smrt-ui/forms';
import type { VendorDisplayData } from '../party-types.js';
import PartySelect from './PartySelect.svelte';

/**
 * Searchable vendor picker for a relation field. Presentation only: the
 * caller owns `search` and `resolve` (returning the vendor DTO, whose
 * `profile.name` is the label) and the "New vendor" action. Registered as
 * the selector for `@happyvertical/smrt-commerce:Vendor`.
 */
export interface Props {
  /** Field name; the selected vendor id posts under it. */
  name: string;
  /** Selected vendor id (bindable). Empty string means no selection. */
  value?: string;
  /** Visible label. Defaults to the localized "Vendor". */
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
  search: (query: string) => Promise<VendorDisplayData[]>;
  /** Caller-owned lookup of the current value when it has not been listed yet. */
  resolve?: (id: string) => Promise<VendorDisplayData | null>;
  /**
   * "New vendor" action, offered only when supplied. Receives the text most
   * recently searched for; a returned vendor is selected.
   */
  onCreate?: (
    query: string,
  ) => void | VendorDisplayData | Promise<void | VendorDisplayData>;
  /** Text for the "New vendor" button. */
  createLabel?: string;
  /** Milliseconds to wait after typing before searching. */
  debounceMs?: number;
  /** Combobox interaction options for agents, or false to opt out. */
  interaction?: ControlInteractionOptions | false;
  /** Called when the selected id changes ('' when cleared). */
  onchange?: (id: string) => void;
}

let { value = $bindable(''), ...rest }: Props = $props();
</script>

<PartySelect kind="vendor" bind:value {...rest} />
