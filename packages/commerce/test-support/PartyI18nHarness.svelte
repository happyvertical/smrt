<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import CustomerDirectory from '../src/svelte/components/CustomerDirectory.svelte';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';
import VendorDetail from '../src/svelte/components/VendorDetail.svelte';

setI18nContext(
  createI18nContext({
    locale: 'de',
    messages: {
      'commerce.party.identity': 'Identität',
      'commerce.party.identity_business': 'Unternehmen',
      'commerce.party.identity_person': 'Person',
      'commerce.party.type': 'Art',
      'commerce.party.status': 'Zustand',
      'commerce.party.status_active': 'Aktiv',
      'commerce.party.email': 'E-Mail',
      'commerce.party.notes': 'Notizen',
      'commerce.party.name': 'Name für {singular}',
      'commerce.party.add_named': '{singular} hinzufügen',
      'commerce.party.edit_named': '{singular} bearbeiten',
      'commerce.party.save_named': '{singular} speichern',
      'commerce.party.manage_named': '{plural} suchen und verwalten.',
      'commerce.party.search_named': '{plural} suchen',
      'commerce.party.pagination': 'Seiten für {singular}',
      'commerce.party.no_contact_details': 'Keine Kontaktdaten erfasst',
      'commerce.party.showing_count': '{count} von {total} angezeigt',
      'commerce.party.amount_unavailable': 'Betrag nicht verfügbar',
      'commerce.vendor.lead_time_days': '{days} Tage Lieferzeit',
    },
  }),
);

const customer = {
  id: 'customer-i18n',
  profile: { name: 'Beispielkunde', identityKind: 'business' as const },
  status: 'active',
};
const vendor = {
  id: 'vendor-i18n',
  profile: { name: 'Beispielanbieter', identityKind: 'person' as const },
  status: 'active',
  leadTimeDays: 7,
  minimumOrderMinor: Number.NaN,
  currency: 'CAD',
  notes: 'Interne Angaben',
};
</script>

<CustomerDirectory
  items={[{ data: customer, href: '/kunden/customer-i18n' }]}
  addHref="/kunden/neu"
  canCreate
  previousHref="/kunden?page=1"
  labels={{ singular: 'Kunde', plural: 'Kunden' }}
/>
<VendorDetail {vendor} />
<CustomerForm
  values={{ identityKind: 'business', name: 'Beispielkunde' }}
  labels={{ singular: 'Kunde' }}
/>
