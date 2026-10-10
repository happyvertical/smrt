import { describe, expect, it } from 'vitest';
import { formatWidgetValue } from '../format.js';
import { spanFromKey, spanFromPointer } from '../resize.js';
import { shortcutsFromNav } from '../widgets/data.js';

describe('formatWidgetValue', () => {
  it('formats by kind and locale', () => {
    expect(formatWidgetValue(1234567, { locale: 'en-US' })).toBe('1,234,567');
    expect(formatWidgetValue(1234567, { locale: 'de-DE' })).toBe('1.234.567');
    expect(
      formatWidgetValue(0.256, { format: 'percent', locale: 'en-US' }),
    ).toBe('25.6%');
    expect(
      formatWidgetValue(12.345, { format: 'decimal', locale: 'en-US' }),
    ).toBe('12.35');
  });

  it('treats money as integer minor units with the currency digits', () => {
    expect(
      formatWidgetValue(125050, {
        format: 'money',
        currency: 'USD',
        locale: 'en-US',
      }),
    ).toBe('$1,250.50');
    expect(
      formatWidgetValue(5000, {
        format: 'money',
        currency: 'JPY',
        locale: 'en-US',
      }),
    ).toBe('¥5,000');
    expect(
      formatWidgetValue(100, {
        format: 'money',
        currency: 'not-a-code',
        locale: 'en-US',
      }),
    ).toBe('$1.00');
  });

  it('renders junk as a dash and survives a bad locale', () => {
    expect(formatWidgetValue(Number.NaN, { locale: 'en' })).toBe('–');
    expect(formatWidgetValue('5', { locale: 'en' })).toBe('–');
    expect(formatWidgetValue(5, { locale: 'not a locale' })).toBe('5');
  });
});

describe('spanFromPointer / spanFromKey', () => {
  const grid = {
    gridWidth: 400,
    columns: 4,
    gap: 0,
    min: 1,
    max: 4,
    rtl: false,
    start: 0,
  };

  it('snaps to the nearest column boundary and clamps', () => {
    expect(spanFromPointer({ ...grid, pointer: 90 })).toBe(1);
    expect(spanFromPointer({ ...grid, pointer: 160 })).toBe(2);
    expect(spanFromPointer({ ...grid, pointer: 260 })).toBe(3);
    expect(spanFromPointer({ ...grid, pointer: 9999 })).toBe(4);
    expect(spanFromPointer({ ...grid, pointer: -50 })).toBe(1);
  });

  it('never exceeds the columns drawn', () => {
    expect(spanFromPointer({ ...grid, columns: 2, pointer: 9999 })).toBe(2);
    expect(spanFromPointer({ ...grid, columns: 1, pointer: 9999 })).toBe(1);
  });

  it('mirrors in right-to-left and respects the widget range', () => {
    expect(
      spanFromPointer({ ...grid, rtl: true, start: 400, pointer: 200 }),
    ).toBe(2);
    expect(spanFromPointer({ ...grid, pointer: 400, max: 2 })).toBe(2);
    expect(spanFromPointer({ ...grid, pointer: 10, min: 2 })).toBe(2);
  });

  it('maps keys, mirrored for rtl', () => {
    expect(spanFromKey('ArrowRight', 2, 1, 4, false)).toBe(3);
    expect(spanFromKey('ArrowRight', 2, 1, 4, true)).toBe(1);
    expect(spanFromKey('ArrowLeft', 1, 1, 4, false)).toBe(1);
    expect(spanFromKey('ArrowUp', 4, 1, 4, false)).toBe(4);
    expect(spanFromKey('ArrowDown', 3, 1, 4, false)).toBe(2);
    expect(spanFromKey('End', 1, 1, 3, false)).toBe(3);
    expect(spanFromKey('Home', 3, 2, 4, false)).toBe(2);
    expect(spanFromKey('a', 2, 1, 4, false)).toBeNull();
  });
});

describe('shortcutsFromNav', () => {
  const sections = [
    {
      id: 'sales',
      items: [
        {
          id: 'inv',
          label: 'Invoices',
          item: { href: '/invoices', icon: 'receipt', description: 'Bills' },
        },
        { id: 'hid', label: 'Hidden', hidden: true, item: { href: '/h' } },
        { id: 'bad', label: 'Bad', item: { href: 'javascript:alert(1)' } },
      ],
    },
    {
      id: 'people',
      items: [{ id: 'usr', label: 'Users', item: { href: '/users' } }],
    },
  ];

  it('lists the visible, safe entries of one section', () => {
    expect(shortcutsFromNav(sections, 'sales')).toEqual({
      items: [
        {
          id: 'inv',
          label: 'Invoices',
          href: '/invoices',
          icon: 'receipt',
          description: 'Bills',
        },
      ],
    });
  });

  it('lists every section without an id', () => {
    expect(shortcutsFromNav(sections).items.map((i) => i.id)).toEqual([
      'inv',
      'usr',
    ]);
  });
});
