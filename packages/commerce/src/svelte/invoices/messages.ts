import { defineMessages } from '@happyvertical/smrt-ui/i18n';

/** Messages for the invoice allocation fields and review presentation. */
export const invoicePreparationMessages = defineMessages({
  'commerce.preparation.allocation': 'Allocation {number}',
  'commerce.preparation.source': 'Reviewed source',
  'commerce.preparation.reference': 'Source reference',
  'commerce.preparation.choose': 'Choose a source or leave this row blank',
  'commerce.preparation.retained': 'Retained source reference: {reference}',
  'commerce.preparation.available':
    '{label} · Available: {amount} {currency} minor units',
  'commerce.preparation.amount': 'Amount ({currency})',
  'commerce.preparation.help':
    'Enter currency amounts, for example 125.00 for CAD. The server validates currency precision and source availability.',
  'commerce.preparation.remove': 'Remove this allocation',
  'commerce.preparation.add': 'Add allocation row',
  'commerce.preparation.restricted':
    'Source details are restricted. Enter references supplied through your authorized workflow.',
  'commerce.preparation.empty':
    'No reviewed sources are available. Retained references remain visible for review.',
  'commerce.preparation.no_rows':
    'No allocations. Add a row to prepare this draft.',
  'commerce.preparation.review': 'Invoice review',
});
