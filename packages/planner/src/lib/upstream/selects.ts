/**
 * STAND-IN for `ModuleUISlot.selects` (happyvertical/smrt#3599): a package UI
 * component marked as THE selector for model X, and the host helper "selector
 * for model X". Generic forms use it for any `foreignKey` / `crossPackageRef`
 * field whose target is X.
 *
 * `SelectorSlot` has the slot's `selects` key as the issue names it
 * (`QualifiedClassName`); `kind` and `component` are the host side (what the
 * planner needs to render it, not manifest data). When #3599 and #3602 ship,
 * read the slots from the packages' manifests (`COMMERCE_UI_SLOTS`) and keep
 * only the `kind` to component table.
 */
import type { Component } from 'svelte';
import CustomerSelect from './CustomerSelect.svelte';
import VendorSelect from './VendorSelect.svelte';

/** A slot, as in `COMMERCE_UI_SLOTS` of happyvertical/smrt#3602. */
export interface SelectorSlot {
  /** The slot's component name in the package's `./svelte` export. */
  name: string;
  /** `selects`: the model this component picks (`@scope/pkg:Class`). */
  selects: string;
  /** Which party DTO the component's `search` and `resolve` speak. */
  kind: 'customer' | 'vendor';
  // biome-ignore lint/suspicious/noExplicitAny: each selector has its own prop type
  component: Component<any>;
}

export const SELECTOR_SLOTS: readonly SelectorSlot[] = [
  {
    name: 'CustomerSelect',
    selects: '@happyvertical/smrt-commerce:Customer',
    kind: 'customer',
    component: CustomerSelect,
  },
  {
    name: 'VendorSelect',
    selects: '@happyvertical/smrt-commerce:Vendor',
    kind: 'vendor',
    component: VendorSelect,
  },
];

/** The registered selector for a model, if there is one. */
export function selectorFor(
  qualifiedModel: string,
  slots: readonly SelectorSlot[] = SELECTOR_SLOTS,
): SelectorSlot | undefined {
  return slots.find((slot) => slot.selects === qualifiedModel);
}
