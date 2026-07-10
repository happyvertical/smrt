import { getContext, setContext } from 'svelte';

const ACCORDION_CONTEXT = Symbol('smrt-accordion');

export interface AccordionContext {
  isOpen(value: string): boolean;
  toggle(value: string): void;
}

export function setAccordionContext(context: AccordionContext): void {
  setContext(ACCORDION_CONTEXT, context);
}

export function getAccordionContext(): AccordionContext {
  const context = getContext<AccordionContext>(ACCORDION_CONTEXT);
  if (!context)
    throw new Error('AccordionItem must be nested inside Accordion');
  return context;
}
