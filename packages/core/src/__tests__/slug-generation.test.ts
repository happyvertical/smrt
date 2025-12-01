/**
 * Tests for slug generation from object fields
 *
 * Verifies the fallback order: name → title → label → id
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject, smrt } from '../index';
import { ObjectRegistry } from '../registry';

// Test class with name field
@smrt()
class SlugTestWithName extends SmrtObject {
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
  }
}

// Test class with title field (no name)
@smrt()
class SlugTestWithTitle extends SmrtObject {
  title: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.title) this.title = options.title;
  }
}

// Test class with label field (no name or title)
@smrt()
class SlugTestWithLabel extends SmrtObject {
  label: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.label) this.label = options.label;
  }
}

// Test class with multiple fields (name takes priority)
@smrt()
class SlugTestWithMultiple extends SmrtObject {
  name: string = '';
  title: string = '';
  label: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name) this.name = options.name;
    if (options.title) this.title = options.title;
    if (options.label) this.label = options.label;
  }
}

// Test class with no slug-friendly fields
@smrt()
class SlugTestWithNone extends SmrtObject {
  description: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.description) this.description = options.description;
  }
}

describe('Slug Generation', () => {
  beforeEach(() => {
    // Clear registry between tests
    ObjectRegistry.clear();
  });

  describe('fallback order: name → title → label → id', () => {
    it('should generate slug from name field', async () => {
      const obj = new SlugTestWithName({
        name: 'My Product Name',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('my-product-name');
    });

    it('should generate slug from title when name is not present', async () => {
      const obj = new SlugTestWithTitle({
        title: 'My Article Title',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('my-article-title');
    });

    it('should generate slug from label when name and title are not present', async () => {
      const obj = new SlugTestWithLabel({
        label: 'My Label Text',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('my-label-text');
    });

    it('should prefer name over title and label', async () => {
      const obj = new SlugTestWithMultiple({
        name: 'Name Value',
        title: 'Title Value',
        label: 'Label Value',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('name-value');
    });

    it('should fall back to id when no slug-friendly fields are present', async () => {
      const obj = new SlugTestWithNone({
        description: 'Some description',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      // Force id generation
      obj.id = 'test-uuid-1234';
      const slug = await obj.getSlug();

      expect(slug).toBe('test-uuid-1234');
    });
  });

  describe('slug formatting', () => {
    it('should convert to lowercase', async () => {
      const obj = new SlugTestWithName({
        name: 'UPPERCASE NAME',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('uppercase-name');
    });

    it('should replace special characters with hyphens', async () => {
      const obj = new SlugTestWithName({
        name: 'Product: The "Best" One!',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('product-the-best-one');
    });

    it('should remove leading and trailing hyphens', async () => {
      const obj = new SlugTestWithName({
        name: '---Leading & Trailing---',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('leading-trailing');
    });

    it('should collapse multiple hyphens into one', async () => {
      const obj = new SlugTestWithName({
        name: 'Multiple   Spaces   Here',
        db: { type: 'sqlite', url: ':memory:' },
      });
      await obj.initialize();

      const slug = await obj.getSlug();

      expect(slug).toBe('multiple-spaces-here');
    });
  });

  describe('explicit slug', () => {
    it('should not override explicitly set slug', async () => {
      const obj = new SlugTestWithName({
        name: 'My Product Name',
        db: { type: 'sqlite', url: ':memory:' },
      });
      // Manually set slug before getSlug is called
      obj.slug = 'custom-slug';

      const slug = await obj.getSlug();

      expect(slug).toBe('custom-slug');
    });
  });
});
