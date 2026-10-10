<script lang="ts">
import type { ControlInteractionOptions } from '@happyvertical/smrt-ui/forms';
import type { CustomerDisplayData } from '../party-types.js';
import PartySelect from './PartySelect.svelte';

/**
 * Searchable customer picker for a relation field. Presentation only: the
 * caller owns `search` and `resolve` (returning the customer DTO, whose
 * `profile.name` is the label) and the "New customer" action. Registered as
 * the selector for `@happyvertical/smrt-commerce:Customer`.
 */
export interface Props {
  /** Field name; the selected customer id posts under it. */
  name: string;
  /** Selected customer id (bindable). Empty string means no selection. */
  value?: string;
  /** Visible label. Defaults to the localized "Customer". */
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
  search: (query: string) => Promise<CustomerDisplayData[]>;
  /** Caller-owned lookup of the current value when it has not been listed yet. */
  resolve?: (id: string) => Promise<CustomerDisplayData | null>;
  /**
   * "New customer" action, offered only when supplied. Receives the text most
   * recently searched for; a returned customer is selected.
   */
  onCreate?: (
    query: string,
  ) => void | CustomerDisplayData | Promise<void | CustomerDisplayData>;
  /** Text for the "New customer" button. */
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

<PartySelect kind="customer" bind:value {...rest} />
