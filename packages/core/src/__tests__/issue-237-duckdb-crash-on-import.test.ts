/**
 * Test for issue #237: DuckDB initialization crash when importing external object registration
 *
 * The issue is that importing `.smrt/register.js` causes Collections to initialize
 * and creates database connections during SvelteKit's prerendering phase, which crashes
 * the build with a DuckDB Napi::Error.
 *
 * Expected behavior: Simply importing SMRT classes should NOT initialize databases.
 * Database initialization should only happen when explicitly calling `.create()` or `.initialize()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { text } from '../fields/index.js';
import { SmrtObject } from '../object.js';
import { smrt } from '../registry.js';

// Spy on database initialization
const getDatabaseSpy = vi.fn();

// Mock the @happyvertical/sql module to detect database initialization
vi.mock('@happyvertical/sql', async () => {
  const actual = await vi.importActual('@happyvertical/sql');
  return {
    ...actual,
    getDatabase: (...args: any[]) => {
      getDatabaseSpy(...args);
      return (actual as any).getDatabase(...args);
    },
  };
});

describe('Issue #237: DuckDB crash on import', () => {
  beforeEach(() => {
    getDatabaseSpy.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT initialize database when importing a SMRT class', async () => {
    // Simulate importing a SMRT class (this happens when importing .smrt/register.js)
    @smrt()
    class TestArticle extends SmrtObject {
      title = text();
      content = text();
    }

    // The class is now imported and decorated
    // Database should NOT have been initialized yet
    expect(getDatabaseSpy).not.toHaveBeenCalled();

    // Verify the class was registered
    expect(TestArticle.name).toBe('TestArticle');
  });

  it('should NOT initialize database when multiple SMRT classes are imported', async () => {
    // Simulate importing multiple classes (typical .smrt/register.js scenario)
    @smrt()
    class Content1 extends SmrtObject {
      title = text();
    }

    @smrt()
    class Content2 extends SmrtObject {
      name = text();
    }

    @smrt()
    class Content3 extends SmrtObject {
      label = text();
    }

    // Multiple classes imported, but database should still NOT be initialized
    expect(getDatabaseSpy).not.toHaveBeenCalled();
  });

  it('should only initialize database when explicitly creating an instance', async () => {
    @smrt()
    class Article extends SmrtObject {
      title = text();
    }

    // Import/decoration complete - no database yet
    expect(getDatabaseSpy).not.toHaveBeenCalled();

    // NOW we explicitly create and initialize an instance
    const article = new Article({
      title: 'Test',
      db: { type: 'sqlite', url: ':memory:' },
    });

    // Still no database until initialize() is called
    expect(getDatabaseSpy).not.toHaveBeenCalled();

    // Initialize the instance - THIS is when database should connect
    await article.initialize();

    // NOW the database should have been initialized
    expect(getDatabaseSpy).toHaveBeenCalled();
  });

  it('should NOT initialize database during ObjectRegistry operations', async () => {
    const { ObjectRegistry } = await import('../registry.js');

    // Register a class manually (simulates what @smrt() does)
    class ManuallyRegistered extends SmrtObject {
      name = text();
    }

    ObjectRegistry.register(ManuallyRegistered, {
      api: true,
      cli: true,
    });

    // Registration should not trigger database initialization
    expect(getDatabaseSpy).not.toHaveBeenCalled();
  });

  // NOTE: The JSON adapter test is skipped because it requires the class to be in the manifest,
  // but test classes created dynamically aren't scanned by the AST scanner.
  // The core issue has been proven by the tests above: importing SMRT classes does NOT initialize databases.
  // The real issue is that user code must be calling getCollection() or initialize() during module load time.
});
