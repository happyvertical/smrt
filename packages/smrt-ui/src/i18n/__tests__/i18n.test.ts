/**
 * Unit coverage for the client i18n core (S13 #1418): the message-default
 * registry, the reactive store's resolution order, and `{var}` interpolation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredMessages,
  createI18nContext,
  defineMessages,
  getRegisteredDefault,
} from '../index.js';

afterEach(() => {
  clearRegisteredMessages();
});

describe('defineMessages', () => {
  it('registers English defaults and returns a typed key map', () => {
    const M = defineMessages({
      'ui.demo.hello': 'Hello',
      'ui.demo.bye': 'Goodbye',
    });
    expect(M['ui.demo.hello']).toBe('ui.demo.hello');
    expect(getRegisteredDefault('ui.demo.hello')).toBe('Hello');
    expect(getRegisteredDefault('ui.demo.bye')).toBe('Goodbye');
  });

  it('is idempotent for an identical default', () => {
    defineMessages({ 'ui.demo.hello': 'Hello' });
    expect(() => defineMessages({ 'ui.demo.hello': 'Hello' })).not.toThrow();
  });

  it('throws when a key is redefined with a different default', () => {
    defineMessages({ 'ui.demo.hello': 'Hello' });
    expect(() => defineMessages({ 'ui.demo.hello': 'Hi' })).toThrow(
      /already registered/,
    );
  });
});

describe('I18nStore.t resolution order', () => {
  it('falls back to the registered default when no snapshot has the key', () => {
    defineMessages({ 'ui.demo.empty': 'No data available' });
    const store = createI18nContext();
    expect(store.t('ui.demo.empty')).toBe('No data available');
    expect(store.locale).toBe('en');
  });

  it('prefers the snapshot template over the registered default', () => {
    defineMessages({ 'ui.demo.empty': 'No data available' });
    const store = createI18nContext({
      locale: 'fr',
      messages: { 'ui.demo.empty': 'Aucune donnée' },
    });
    expect(store.t('ui.demo.empty')).toBe('Aucune donnée');
    expect(store.locale).toBe('fr');
  });

  it('falls back to the key itself for an unknown message (never blank)', () => {
    const store = createI18nContext();
    expect(store.t('ui.demo.unknown')).toBe('ui.demo.unknown');
  });

  it('reflects a snapshot reassignment (locale switch)', () => {
    defineMessages({ 'ui.demo.empty': 'No data available' });
    const store = createI18nContext();
    expect(store.t('ui.demo.empty')).toBe('No data available');
    store.snapshot = {
      locale: 'es',
      messages: { 'ui.demo.empty': 'Sin datos' },
    };
    expect(store.locale).toBe('es');
    expect(store.t('ui.demo.empty')).toBe('Sin datos');
  });
});

describe('interpolation', () => {
  it('substitutes {var} placeholders from the snapshot template', () => {
    const store = createI18nContext({
      locale: 'en',
      messages: { 'ui.demo.range': 'Showing {count} of {total}' },
    });
    expect(store.t('ui.demo.range', { count: 3, total: 9 })).toBe(
      'Showing 3 of 9',
    );
  });

  it('collapses missing variables to empty strings', () => {
    defineMessages({ 'ui.demo.greet': 'Hi {name}{title}' });
    const store = createI18nContext();
    expect(store.t('ui.demo.greet', { name: 'Ada' })).toBe('Hi Ada');
  });
});
