import { describe, expect, it } from 'vitest';
import {
  assistantOpenKey,
  isFramed,
  isPluginRequest,
  planLayout,
  readAssistantOpen,
  shellStorageKey,
  writeAssistantOpen,
} from './layout.ts';

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe('the chat column choice', () => {
  it('is kept per owner', () => {
    expect(assistantOpenKey('a')).not.toBe(assistantOpenKey('b'));
    expect(assistantOpenKey('a')).toContain('a');
    expect(assistantOpenKey(null)).toBe(assistantOpenKey(undefined));
  });

  it('keeps the layout preferences per owner under their own key', () => {
    expect(shellStorageKey('a')).not.toBe(shellStorageKey('b'));
    expect(shellStorageKey('a')).not.toBe(assistantOpenKey('a'));
    expect(shellStorageKey(null)).toBe('smrt-app-shell');
  });

  it('is closed until the owner opens it', () => {
    const store = memory();
    const key = assistantOpenKey('a');
    expect(readAssistantOpen(store, key)).toBe(false);
    writeAssistantOpen(store, key, true);
    expect(store.map.get(key)).toBe('1');
    expect(readAssistantOpen(store, key)).toBe(true);
    expect(readAssistantOpen(store, assistantOpenKey('b'))).toBe(false);
    writeAssistantOpen(store, key, false);
    expect(readAssistantOpen(store, key)).toBe(false);
  });

  it('survives missing or throwing storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readAssistantOpen(broken, 'k')).toBe(false);
    expect(() => writeAssistantOpen(broken, 'k', false)).not.toThrow();
    expect(readAssistantOpen(null, 'k')).toBe(false);
  });
});

describe('plugin mode', () => {
  it('is an iframe document request or an explicit embed flag', () => {
    expect(isPluginRequest({ secFetchDest: 'iframe' })).toBe(true);
    expect(isPluginRequest({ embed: 'plugin' })).toBe(true);
    expect(isPluginRequest({ secFetchDest: 'document' })).toBe(false);
    expect(isPluginRequest({ secFetchDest: null, embed: null })).toBe(false);
    expect(isPluginRequest({ embed: '1' })).toBe(false);
  });

  it('is a framed page on the client', () => {
    const top = {};
    expect(isFramed({ self: top, top })).toBe(false);
    expect(isFramed({ self: {}, top })).toBe(true);
    expect(isFramed(undefined)).toBe(false);
  });

  it('has no chat and no voice inside a plugin, or for a non-owner', () => {
    expect(planLayout({ owner: true, plugin: false })).toEqual({
      chat: true,
      voice: true,
    });
    expect(planLayout({ owner: true, plugin: true })).toEqual({
      chat: false,
      voice: false,
    });
    expect(planLayout({ owner: false, plugin: false }).chat).toBe(false);
  });
});
