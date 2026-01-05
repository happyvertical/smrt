import { describe, expect, it } from 'vitest';
import {
  formatEmail,
  formatText,
  matchOption,
  parseSpokenBoolean,
} from '../formatters';

describe('Form Formatters', () => {
  it('should format email correctly', () => {
    expect(formatEmail('john at example dot com')).toBe('john@example.com');
    expect(formatEmail('JOHN DOT DOE AT GMAIL DOT COM')).toBe(
      'john.doe@gmail.com',
    );
  });

  it('should format text correctly', () => {
    expect(formatText('my name is John')).toBe('John');
    expect(formatText('um so well hello')).toBe('hello');
  });

  it('should parse spoken boolean correctly', () => {
    expect(parseSpokenBoolean('yes please')).toBe(true);
    expect(parseSpokenBoolean('no way')).toBe(false);
    expect(parseSpokenBoolean('maybe')).toBe(null);
  });

  it('should match options correctly', () => {
    const options = [
      { label: 'Red', value: 'red' },
      { label: 'Green', value: 'green' },
      { label: 'Blue', value: 'blue' },
    ];
    expect(matchOption('red', options)).toBe('red');
    expect(matchOption('I want green', options)).toBe('green');
    expect(matchOption('yellow', options)).toBe(null);
  });
});
