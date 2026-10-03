import { defineMessages } from '@happyvertical/smrt-ui/i18n';
/** Localizable purchasing presentation text; domain names and policy remain caller-owned. */
export const P = defineMessages({
  'commerce.purchase.source': 'Purchasing source',
  'commerce.purchase.choose': 'Choose a vendor and source',
  'commerce.purchase.use': 'Use this source',
  'commerce.purchase.empty_sources': 'No sources available.',
  'commerce.purchase.create': 'Prepare purchase or award',
  'commerce.purchase.amend': 'Amend purchase or award',
  'commerce.purchase.reduce': 'Reduce or close retained allocations',
  'commerce.purchase.boundary':
    'Selecting a source does not record a commitment. Recording requires a separate reviewed decision.',
  'commerce.purchase.reduction_hint':
    'Enter every retained allocation explicitly. Enter zero to close an allocation; leaving it blank does not mean zero.',
  'commerce.purchase.instrument': 'Instrument',
  'commerce.purchase.choose_instrument': 'Choose an instrument',
  'commerce.purchase.allocations': 'Explicit allocation amounts, including tax',
  'commerce.purchase.source_amount': 'Source amount',
  'commerce.purchase.minimum': 'Minimum',
  'commerce.purchase.maximum': 'Maximum',
  'commerce.purchase.unknown': 'Unknown',
  'commerce.purchase.empty_allocations': 'No allocations supplied.',
  'commerce.purchase.tax': 'Included tax',
  'commerce.purchase.scope': 'Ordered or awarded scope',
  'commerce.purchase.inclusions': 'Inclusions',
  'commerce.purchase.exclusions': 'Exclusions',
  'commerce.purchase.reason': 'Decision evidence or amendment reason',
  'commerce.purchase.review': 'Review before recording',
  'commerce.purchase.review_button': 'Review purchase or award',
  'commerce.purchase.confirm':
    'I explicitly authorize this purchase, award or recorded amendment.',
  'commerce.purchase.record': 'Record reviewed decision',
  'commerce.purchase.edit': 'Back to details',
  'commerce.purchase.cancel': 'Cancel',
  'commerce.purchase.add': 'Add allocation',
  'commerce.purchase.remove': 'Remove {label}',
  'commerce.purchase.readonly': 'Read only',
  'commerce.purchase.total': 'Reviewed total',
  'commerce.purchase.uncertain':
    'Retry the same reviewed submission. Its request identity and review fingerprint are retained.',
});
