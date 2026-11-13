import { describe, expect, it } from 'vitest';
import { greeting } from './greeting.ts';

describe('greeting', () => {
  it('greets the owner by name', () => {
    expect(greeting({ name: 'Will' })).toBe('Hello, Will.');
    expect(greeting({ name: '  Will  ' })).toBe('Hello, Will.');
  });
  it('has no name to use: a plain hello, never "there" or the email', () => {
    expect(greeting({})).toBe('Hello.');
    expect(greeting({ name: '' })).toBe('Hello.');
    expect(greeting({ name: '   ' })).toBe('Hello.');
    expect(greeting(null)).toBe('Hello.');
    expect(greeting(undefined)).toBe('Hello.');
  });
});
