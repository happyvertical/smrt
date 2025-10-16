import { describe, it, expect } from 'vitest';
import { text, integer } from './index';

describe('Field DEFAULT CAST for DuckDB', () => {
  it('should generate CAST for TEXT fields with empty string default', () => {
    const nameField = text({ default: '' });
    const constraints = nameField.getSqlConstraints();

    expect(constraints).toContain("DEFAULT CAST('' AS TEXT)");
  });

  it('should generate CAST for TEXT fields with NULL default', () => {
    const urlField = text({ default: null });
    const constraints = urlField.getSqlConstraints();

    expect(constraints).toContain('DEFAULT CAST(NULL AS TEXT)');
  });

  it('should NOT generate CAST for TEXT fields with non-empty default', () => {
    const statusField = text({ default: 'active' });
    const constraints = statusField.getSqlConstraints();

    // Should have DEFAULT but without CAST
    const hasDefault = constraints.some(c => c.startsWith('DEFAULT'));
    const hasCast = constraints.some(c => c.includes('CAST'));

    expect(hasDefault).toBe(true);
    expect(hasCast).toBe(false);
  });

  it('should NOT generate CAST for INTEGER fields', () => {
    const countField = integer({ default: 0 });
    const constraints = countField.getSqlConstraints();

    // Should have DEFAULT but without CAST (not a TEXT field)
    const hasDefault = constraints.some(c => c.startsWith('DEFAULT'));
    const hasCast = constraints.some(c => c.includes('CAST'));

    expect(hasDefault).toBe(true);
    expect(hasCast).toBe(false);
  });
});
