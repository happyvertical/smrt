import { render } from 'svelte/server';
import CustomerForm from '../src/svelte/components/CustomerForm.svelte';

export function renderNativePage(): string {
  const body = render(CustomerForm, {
    props: {
      values: {
        identityKind: 'business',
        name: 'Native Client',
        creditLimit: '1250.00',
        contacts: [{ id: 'contact-native', name: 'Native Contact' }],
      },
      transport: {
        action: '/party-submit',
        hiddenFields: { requestToken: 'native-request', expectedTenantId: 'tenant-native' },
        addContactIntent: 'add-native-contact',
      },
      fieldNames: { name: 'clientName' },
    },
  }).body;
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Native party form</title></head><body>${body}</body></html>`;
}
