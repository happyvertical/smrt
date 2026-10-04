import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CountrySelect from '../CountrySelect.svelte';
import CurrencySelect from '../CurrencySelect.svelte';
import ProvinceSelect from '../ProvinceSelect.svelte';

describe('selectors SSR', () => {
  it('localizes labels while preserving exact retained currency', () => {
    const html = render(CurrencySelect, {
      props: {
        value: ' raw ',
        name: 'currency',
        locale: 'fr',
        readOnly: true,
        form: 'external',
      },
    }).body;
    expect(html).toContain(' raw ');
    expect(html).toContain('type="hidden"');
    expect(html).toContain('form="external"');
    expect(html).toContain('dollar canadien');
  });
  it('renders localized countries and safe invalid locale fallback', () => {
    expect(
      render(CountrySelect, { props: { locale: 'fr', value: 'US' } }).body,
    ).toContain('États-Unis');
    expect(
      render(CountrySelect, { props: { locale: 'bad_locale' } }).body,
    ).toContain('United States');
  });
  it('renders free-text regions and explicit empty options override', () => {
    expect(
      render(ProvinceSelect, { props: { country: 'GB', value: 'London' } })
        .body,
    ).toContain('type="text"');
    const html = render(ProvinceSelect, {
      props: { country: 'GB', value: 'London', options: [] },
    }).body;
    expect(html).toContain('<select');
    expect(html).toContain('London');
  });
});
