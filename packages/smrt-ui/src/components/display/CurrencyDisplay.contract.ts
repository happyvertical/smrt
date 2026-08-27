import type { ComponentProps } from 'svelte';
import type CurrencyDisplay from './CurrencyDisplay.svelte';

type Assert<T extends true> = T;

/** Compile-time guard for Commerce models whose currency field is `string`. */
export type CurrencyDisplayAcceptsCommerceCurrency = Assert<
  string extends NonNullable<ComponentProps<typeof CurrencyDisplay>['currency']>
    ? true
    : false
>;
