import { describe, expect, it } from 'vitest';
import { FALLBACK_ICONS, modelIcon, modelIcons } from './model-icon.ts';

describe('modelIcon', () => {
  it('is deterministic', () => {
    for (const n of ['Widget', 'Client', 'zzz'])
      expect(modelIcon(n)).toBe(modelIcon(n));
  });

  it('matches name keywords across casing and plurals', () => {
    expect(modelIcon('Client')).toBe('users');
    expect(modelIcon('customers')).toBe('users');
    expect(modelIcon('Invoice')).toBe('receipt');
    expect(modelIcon('dog_rate')).toBe('tag');
    expect(modelIcon('DogWalk')).toBe('calendar');
    expect(modelIcon('Appointments')).toBe('calendar');
  });

  it('does not match inside other words', () => {
    expect(FALLBACK_ICONS).toContain(modelIcon('Carpet'));
  });

  it('falls back to field hints, then the neutral palette', () => {
    const money = { type: 'money', money: { currency: 'USD', scale: 2 } };
    expect(modelIcon('Thing', { cost: money as never })).toBe('tag');
    expect(modelIcon('Thing', { on: { type: 'date' } })).toBe('calendar');
    expect(FALLBACK_ICONS).toContain(modelIcon('Thing'));
  });

  it('usually gives different unknown names different icons', () => {
    const names = [
      'Alpha',
      'Bravo',
      'Gadget',
      'Widget',
      'Zebra',
      'Quux',
      'Orb',
    ];
    expect(new Set(names.map((n) => modelIcon(n))).size).toBeGreaterThan(3);
  });
});

describe('modelIcons', () => {
  it('never gives two models of one menu the same icon', () => {
    const icons = modelIcons({
      Clients: { fields: {} },
      Customers: { fields: {} },
      Walks: { fields: {} },
      Orders: { fields: {} },
      Invoices: { fields: {} },
    });
    expect(icons.Clients).toBe('users');
    expect(icons.Customers).not.toBe(icons.Clients);
    expect(new Set(Object.values(icons)).size).toBe(5);
  });

  it('is stable and does not depend on declaration order', () => {
    const a = modelIcons({ Customers: {}, Clients: {} });
    const b = modelIcons({ Clients: {}, Customers: {} });
    expect(a).toEqual(b);
    expect(modelIcons({ Customers: {}, Clients: {} })).toEqual(a);
  });
});
