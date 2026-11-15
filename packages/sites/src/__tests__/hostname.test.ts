/**
 * Hostname helper tests (pure, in-process). Behaviour ported from the
 * happyvertical.com Work copy.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultZoneFor,
  hostnameBelongsToZone,
  parseHostname,
} from '../hostname';

describe('parseHostname', () => {
  it('trims, lowercases and drops one trailing dot', () => {
    expect(parseHostname('  Work.HappyVertical.com. ')).toBe(
      'work.happyvertical.com',
    );
    expect(parseHostname('A.COM')).toBe('a.com');
    expect(parseHostname('a.com..')).toBeNull();
  });

  it('rejects non-hostnames', () => {
    for (const bad of [
      '',
      '   ',
      '.',
      'localhost',
      'https://a.com',
      'a.com/x',
      'a.com:8080',
      '*.a.com',
      'a..com',
      '.a.com',
      '-a.com',
      'a-.com',
      '1.2.3.4',
      'a.123',
      'a_b.com',
      'a b.com',
      'bücher.example',
    ]) {
      expect(parseHostname(bad), bad).toBeNull();
    }
  });

  it('rejects non-strings', () => {
    for (const bad of [42, null, undefined, {}, ['a.com']]) {
      expect(parseHostname(bad)).toBeNull();
    }
  });

  it('accepts punycode labels and numeric non-TLD labels', () => {
    expect(parseHostname('xn--bcher-kva.example')).toBe(
      'xn--bcher-kva.example',
    );
    expect(parseHostname('1.example.com')).toBe('1.example.com');
    expect(parseHostname('a.xn--p1ai')).toBe('a.xn--p1ai');
  });

  it('enforces label (63) and total (253) length limits', () => {
    const l63 = 'a'.repeat(63);
    expect(parseHostname(`${l63}.com`)).toBe(`${l63}.com`);
    expect(parseHostname(`${'a'.repeat(64)}.com`)).toBeNull();
    const long = `${Array(4).fill('a'.repeat(61)).join('.')}.com`; // 4*61+3+4 = 251
    expect(parseHostname(long)).toBe(long);
    expect(parseHostname(`${long}.bb`)).toBeNull(); // 254 > 253
    expect(parseHostname(`${long}.b`)).toBe(`${long}.b`); // 253 exactly
  });
});

describe('defaultZoneFor', () => {
  it('uses the last two labels', () => {
    expect(defaultZoneFor('work.happyvertical.com')).toBe('happyvertical.com');
    expect(defaultZoneFor('a.b.c.example.org')).toBe('example.org');
  });

  it('returns an apex unchanged', () => {
    expect(defaultZoneFor('happyvertical.com')).toBe('happyvertical.com');
  });

  it('does not guess multi-part public suffixes', () => {
    expect(defaultZoneFor('www.example.co.uk')).toBe('co.uk');
  });
});

describe('hostnameBelongsToZone', () => {
  it('accepts the apex and subdomains', () => {
    expect(
      hostnameBelongsToZone('work.happyvertical.com', 'happyvertical.com'),
    ).toBe(true);
    expect(
      hostnameBelongsToZone('happyvertical.com', 'happyvertical.com'),
    ).toBe(true);
    expect(hostnameBelongsToZone('a.b.example.co.uk', 'example.co.uk')).toBe(
      true,
    );
  });

  it('rejects look-alike suffixes and parents', () => {
    expect(
      hostnameBelongsToZone('evilhappyvertical.com', 'happyvertical.com'),
    ).toBe(false);
    expect(hostnameBelongsToZone('example.com', 'www.example.com')).toBe(false);
    expect(hostnameBelongsToZone('example.com.evil.io', 'example.com')).toBe(
      false,
    );
  });

  it('is case-sensitive: callers normalise first', () => {
    expect(hostnameBelongsToZone('A.example.com', 'example.com')).toBe(true);
    expect(hostnameBelongsToZone('a.example.com', 'Example.com')).toBe(false);
  });
});
