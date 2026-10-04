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
  'commerce.purchase.unavailable': 'Amount unavailable',
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
  'commerce.purchase.demo_added':
    'Demo: allocation added; entered values retained.',
  'commerce.purchase.demo_removed': 'Demo: allocation removed.',
  'commerce.purchase.demo_invalid':
    'Demo validation: enter valid CAD amounts and included tax no greater than the total. Your values are retained.',
  'commerce.purchase.demo_authority':
    'Local CAD demonstration only; the application server owns validation and authorization.',
  'commerce.purchase.demo_review': 'Demo review of supplied source evidence.',
  'commerce.purchase.demo_edit':
    'Demo: return to editing; request identity retained.',
  'commerce.purchase.demo_uncertain':
    'Demo uncertain response. Values, request identity and review fingerprint retained; no financial record was written.',
  'commerce.purchase.demo_source':
    'Demo source selected; no commitment recorded.',
  'commerce.purchase.demo_notice':
    'This demonstration simulates preparation, review and an uncertain response. No purchase or award is written.',
  'commerce.purchase.demo_amendment': 'Preview ordinary amendment',
  'commerce.purchase.demo_reduction': 'Preview explicit reduction',
  'commerce.purchase.demo_unavailable': 'Unavailable source',
  'commerce.purchase.demo_order': 'Purchase order',
  'commerce.purchase.demo_agreement': 'Agreement',
  'commerce.purchase.demo_additional': 'Additional allocation {number}',
});
