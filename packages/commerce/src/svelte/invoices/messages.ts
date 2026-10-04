import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const invoicePreparationMessages = defineMessages({
  'commerce.preparation.title': 'Prepare invoice',
  'commerce.invoice.customer': 'Customer',
  'commerce.invoice.chooseCustomer': 'Choose a customer',
  'commerce.invoice.issued': 'Invoice date',
  'commerce.invoice.due': 'Due date',
  'commerce.invoice.currency': 'Currency',
  'commerce.invoice.terms': 'Payment terms',
  'commerce.invoice.defaultTax': 'Default tax (%)',
  'commerce.invoice.line': 'Invoice line {number}',
  'commerce.invoice.description': 'Description',
  'commerce.invoice.sku': 'SKU',
  'commerce.invoice.quantity': 'Quantity',
  'commerce.invoice.unitPrice': 'Unit price ({currency})',
  'commerce.invoice.discountType': 'Discount type',
  'commerce.invoice.flat': 'Flat amount',
  'commerce.invoice.percent': 'Percentage',
  'commerce.invoice.discountValue': 'Discount value',
  'commerce.invoice.taxMode': 'Tax mode',
  'commerce.invoice.inherit': 'Inherit default tax',
  'commerce.invoice.override': 'Override tax',
  'commerce.invoice.taxRate': 'Line tax (%)',
  'commerce.invoice.remove': 'Remove line',
  'commerce.invoice.add': 'Add line',
  'commerce.invoice.empty': 'No invoice lines. Add a line to begin.',
  'commerce.invoice.gross': 'Gross',
  'commerce.invoice.discount': 'Discount',
  'commerce.invoice.subtotal': 'Subtotal',
  'commerce.invoice.tax': 'Tax',
  'commerce.invoice.total': 'Total',
  'commerce.invoice.invalid':
    'Totals unavailable until quantity, price, discount, tax and currency are valid.',
  'commerce.invoice.preview':
    'Calculated preview; the server revalidates prices, tax and totals.',
  'commerce.invoice.retained': 'Retained reference: {reference}',

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
