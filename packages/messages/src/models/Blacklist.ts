import { SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Blacklist - Block entries for email filtering
 *
 * Supports three pattern types:
 * - email: Exact email address (spam@example.com)
 * - domain: Entire domain (*@spam.com)
 * - regex: Custom regex pattern
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
  tenantScoped: true,
})
export class Blacklist extends SmrtObject {
  pattern: string = '';
  type: 'email' | 'domain' | 'regex' = 'email';
  reason: string = '';
  autoArchive: boolean = true;

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
   * Check if an email address matches this blacklist entry
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
