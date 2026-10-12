import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import { JSDOM } from 'jsdom';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import * as publicUI from '../src/svelte/index.js';

const values = { vendorId: 'missing', reference: ' PO-7 ', notes: 'Do not trim\nnotes', expectedDate: 'not-a-date', shipTo: 'Dock 2\nEdmonton' };
const props = { action: '/header', values, vendors: [{ value: 'vendor-1', label: 'North' }], hiddenFields: [{ name: 'requestId', value: 'same-request' }] };
const documentFor = (extra = {}) => new JSDOM(render(publicUI.PurchaseOrderHeaderForm, { props: { ...props, ...extra } }).body).window.document;

describe('purchase header native contract', () => {
  it('exports a registered header-only form and posts raw retained fields', () => {
    expect(ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'purchase-order-header-form')).toBe(publicUI.PurchaseOrderHeaderForm);
    const doc = documentFor();
    expect(doc.querySelector('form')?.method).toBe('post');
    expect(doc.querySelector('form')?.getAttribute('action')).toBe('/header');
    for (const [name, value] of Object.entries(values)) expect(doc.querySelector<HTMLInputElement>(`[name=${name}]`)?.value).toBe(value);
    expect(doc.querySelector<HTMLInputElement>('[name=requestId]')?.value).toBe('same-request');
    expect(doc.querySelector('[name=allocationAmount]')).toBeNull();
    expect(doc.querySelector('option[value=missing]')?.textContent).toContain('Unavailable vendor');
  });
  it('adapts field names and associates each server error without discarding malformed input', () => {
    const doc = documentFor({ names: { expectedDate: 'delivery' }, errors: { expectedDate: 'Invalid calendar date', vendorId: 'Vendor unavailable' }, message: 'Please correct the header', intent: { name: 'operation', value: 'header' } });
    const date = doc.querySelector<HTMLInputElement>('[name=delivery]');
    expect(date?.value).toBe('not-a-date');
    expect(date?.getAttribute('aria-invalid')).toBe('true');
    expect(doc.getElementById(date?.getAttribute('aria-describedby') ?? '')?.textContent).toContain('Invalid calendar date');
    expect(doc.querySelector('button[name=operation][value=header]')).not.toBeNull();
    expect(doc.querySelector('[role=alert]')?.textContent).toBe('Please correct the header');
  });
  it('posts a retained disabled vendor without offering other unavailable choices', () => {
    const doc = documentFor({ vendors: [{ value: 'missing', label: 'Old vendor', disabled: true }, { value: 'blocked', label: 'Blocked', disabled: true }] });
    expect(doc.querySelector<HTMLOptionElement>('option[value=missing]')?.disabled).toBe(false);
    expect(doc.querySelector('option[value=missing]')?.textContent).toContain('Unavailable vendor');
    expect(doc.querySelector<HTMLOptionElement>('option[value=blocked]')?.disabled).toBe(true);
  });
  it('renders missing optional values empty and presentation restrictions disable writes', () => {
    const doc = documentFor({ values: {}, readonly: true });
    expect(doc.querySelector<HTMLInputElement>('[name=expectedDate]')?.value).toBe('');
    expect(doc.querySelector('fieldset')?.disabled).toBe(true);
    expect(doc.querySelector('button[type=submit]')).toBeNull();
    expect(documentFor({ busy: true }).querySelector('fieldset')?.disabled).toBe(true);
  });
});
