import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Whitelist - Allow-only entries for email filtering
 *
 * Supports three pattern types:
 * - email: Exact email address (user@example.com)
 * - domain: Entire domain (*@example.com)
 * - regex: Custom regex pattern
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
  tenantScoped: true,
})
export class Whitelist extends SmrtObject {
  pattern: string = '';
  type: 'email' | 'domain' | 'regex' = 'email';
  category: string | null = null;
  description: string = '';

  constructor(options: any = {}) {
    super(options);

    if (options.pattern !== undefined) {
      this.pattern = options.pattern;
    }
    if (options.type !== undefined) {
      this.type = options.type;
    }
  }

  /**
   * Check if an email address matches this whitelist entry
   */
  matches(email: string): boolean {
    const normalizedEmail = email.toLowerCase().trim();

    switch (this.type) {
      case 'email':
        return normalizedEmail === this.pattern.toLowerCase().trim();

      case 'domain': {
        const domain = normalizedEmail.split('@')[1];
        return domain === this.pattern.toLowerCase().trim();
      }

      case 'regex': {
        const regex = new RegExp(this.pattern, 'i');
        return regex.test(normalizedEmail);
      }

      default:
        return false;
    }
  }
}
