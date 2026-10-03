import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const invoicePreparationMessages = defineMessages({
  'commerce.preparation.title': 'Prepare invoice',
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
  'commerce.preparation.save': 'Save invoice draft',
  'commerce.preparation.cancel': 'Cancel',
  'commerce.preparation.restricted':
    'Source details are restricted. Enter references supplied through your authorized workflow.',
  'commerce.preparation.empty':
    'No reviewed sources are available. Retained references remain visible for review.',
  'commerce.preparation.no_rows':
    'No allocations. Add a row to prepare this draft.',
  'commerce.preparation.readonly': 'This draft is read-only.',
  'commerce.preparation.uncertain':
    'The outcome is uncertain. Your values and request identity are retained; follow your application’s retry guidance.',
  'commerce.preparation.review': 'Invoice review',
});
