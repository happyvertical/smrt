import { describe, expect, it } from 'vitest';
import {
  buildPaletteSections,
  flattenSections,
  orderProviders,
} from '../rank.js';
import type { PaletteItem, PaletteProvider } from '../types.js';

const nav: PaletteProvider = { id: 'nav', label: 'Go to', order: 10 };
const cmd: PaletteProvider = { id: 'cmd', label: 'Create', order: 5 };
const rec: PaletteProvider = { id: 'rec', label: 'Records', order: 30 };

const item = (id: string, title: string, extra: Partial<PaletteItem> = {}) => ({
  id,
  title,
  ...extra,
});

describe('palette ranking', () => {
  it('orders providers by order, then registration', () => {
    const a = { id: 'a', label: 'A' };
    const b = { id: 'b', label: 'B' };
    expect(orderProviders([nav, a, cmd, b]).map((p) => p.id)).toEqual([
      'a',
      'b',
      'cmd',
      'nav',
    ]);
  });

  it('shows everything grouped when the query is empty', () => {
    const sections = buildPaletteSections({
      providers: [nav, cmd],
      local: {
        nav: [item('1', 'Invoices'), item('2', 'Customers')],
        cmd: [item('n', 'New invoice')],
      },
      remote: {},
      query: '',
    });
    expect(sections.map((s) => s.label)).toEqual(['Create', 'Go to']);
    expect(sections[1].results.map((r) => r.item.title)).toEqual([
      'Invoices',
      'Customers',
    ]);
    expect(sections[0].results[0].key).toBe('cmd:n');
  });

  it('filters and ranks local rows and omits empty groups', () => {
    const sections = buildPaletteSections({
      providers: [nav, cmd],
      local: {
        nav: [item('1', 'Reinvent'), item('2', 'Invoices')],
        cmd: [item('n', 'New customer')],
      },
      remote: {},
      query: 'inv',
    });
    expect(sections.map((s) => s.label)).toEqual(['Go to']);
    expect(sections[0].results.map((r) => r.item.title)).toEqual([
      'Invoices',
      'Reinvent',
    ]);
    expect(sections[0].results[0].titleRanges).toEqual([[0, 3]]);
  });

  it('applies boost, per-group limits and item groups', () => {
    const sections = buildPaletteSections({
      providers: [{ ...nav, limit: 3 }],
      local: {
        nav: [
          item('1', 'Alpha'),
          item('2', 'Beta', { boost: 500 }),
          item('3', 'Gamma'),
          item('4', 'Delta', { group: 'Elsewhere', boost: 100 }),
        ],
      },
      remote: {},
      query: '',
    });
    expect(sections.map((s) => [s.label, s.results.length])).toEqual([
      ['Go to', 2],
      ['Elsewhere', 1],
    ]);
    expect(sections[0].results[0].item.title).toBe('Beta');
  });

  it('adds remote rows after local ones, unfiltered, only for a query', () => {
    const input = {
      providers: [{ ...rec }],
      local: { rec: [item('l', 'Acme local')] },
      remote: { rec: [item('r', 'Zeta Corp'), item('l', 'Acme local')] },
    };
    expect(
      buildPaletteSections({ ...input, query: '' })[0].results.map(
        (r) => r.item.id,
      ),
    ).toEqual(['l']);
    const sections = buildPaletteSections({ ...input, query: 'acme' });
    // 'Zeta Corp' does not match the query; the provider vouches for it.
    expect(sections[0].results.map((r) => r.item.id)).toEqual(['l', 'r']);
  });

  it('marks disabled rows unselectable and flattens in display order', () => {
    const sections = buildPaletteSections({
      providers: [nav, cmd],
      local: {
        nav: [item('1', 'Locked', { disabled: 'No access' })],
        cmd: [item('n', 'New')],
      },
      remote: {},
      query: '',
    });
    const flat = flattenSections(sections);
    expect(flat.map((r) => r.key)).toEqual(['cmd:n', 'nav:1']);
    expect(flat[1].selectable).toBe(false);
  });

  it('drops duplicate keys within a provider', () => {
    const sections = buildPaletteSections({
      providers: [nav],
      local: { nav: [item('1', 'One'), item('1', 'One again')] },
      remote: {},
      query: '',
    });
    expect(sections[0].results).toHaveLength(1);
  });
});
