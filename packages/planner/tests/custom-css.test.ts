import { describe, expect, it } from 'vitest';
import {
  approveCustomCss,
  containCustomCss,
  customCssApproved,
  customCssDisabled,
  sha256,
} from '../src/lib/theme/custom-css.svelte.ts';

describe('untrusted cookbook CSS', () => {
  it('applies only CSS the visitor approved, exactly as approved', () => {
    const css = '.smrt-admin-shell { color: red; }';
    expect(customCssApproved(css)).toBe(false);
    approveCustomCss(css);
    expect(customCssApproved(css)).toBe(true);
    expect(customCssApproved(`${css} `)).toBe(false);
  });

  it('binds approval to a SHA-256 of the exact text', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
    approveCustomCss('.a { color: red }');
    expect(customCssApproved('.a { color: blue }')).toBe(false);
  });

  it('turns custom CSS off from the address bar', () => {
    expect(customCssDisabled('?styles=off')).toBe(true);
    expect(customCssDisabled('?packages=a&styles=off')).toBe(true);
    expect(customCssDisabled('?styles=on')).toBe(false);
    expect(customCssDisabled('')).toBe(false);
  });

  it('applies nothing where the browser cannot parse CSS', () => {
    expect(containCustomCss('body { display: none }', '[x]')).toBe('');
  });
});
