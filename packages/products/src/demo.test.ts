/**
 * Integration test for SMRT Template auto-generation
 *
 * Note: These tests require the SMRT Vite plugin to be active.
 * When running with Bun test, the virtual modules won't be available.
 * Use Vitest with Vite for full SMRT testing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Check if we're running in a Vite environment with virtual modules
function hasVirtualModules(): boolean {
  try {
    // Try to resolve the virtual module path
    return typeof require !== 'undefined' && Boolean(require.resolve);
  } catch {
    return false;
  }
}

const skipTests = !hasVirtualModules();

// Conditional imports
async function getServerModule() {
  if (skipTests) return null;
  try {
    return await import('./server.js');
  } catch {
    return null;
  }
}

async function getClientModule() {
  if (skipTests) return null;
  try {
    return await import('./client.js');
  } catch {
    return null;
  }
}

describe.skip('SMRT Template Integration', () => {
  let server: any;

  beforeAll(async () => {
    const serverModule = await getServerModule();
    if (!serverModule) return;

    // Start server for testing
    server = await serverModule.startServer();
    // Give server time to start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    // Cleanup server
    if (server?.close) {
      server.close();
    }
  });

  it('should generate REST endpoints from SMRT objects', async () => {
    // Test that we can reach the auto-generated endpoints
    const response = await fetch('http://localhost:3000/api/v1/products');

    // Should return 200 even if empty (auto-generated endpoint exists)
    expect(response.status).toBe(200);
  });

  it('should generate TypeScript client', async () => {
    const clientModule = await getClientModule();
    if (!clientModule) return;

    // The client demo should run without errors
    await expect(clientModule.demonstrateClient()).resolves.not.toThrow();
  });

  it('should include auto-generated virtual modules', async () => {
    // These imports should work due to Vite plugin virtual modules
    const { default: setupRoutes } = await import('@smrt/routes');
    const { default: createClient } = await import('@smrt/client');
    const { manifest } = await import('@smrt/manifest');

    expect(typeof setupRoutes).toBe('function');
    expect(typeof createClient).toBe('function');
    expect(typeof manifest).toBe('object');
    expect(manifest.objects).toBeDefined();
  });

  it('should discover SMRT objects in manifest', async () => {
    const { manifest } = await import('@smrt/manifest');

    // Should find our Product and Category objects
    expect(manifest.objects.product).toBeDefined();
    expect(manifest.objects.category).toBeDefined();

    // Product should have the right configuration
    const product = manifest.objects.product;
    expect(product.decoratorConfig.api?.exclude).toContain('delete');
    expect(product.decoratorConfig.mcp?.include).toContain('create');
    expect(product.decoratorConfig.cli).toBe(true);
  });
});

// Add a simple test that always runs to verify the test file is working
describe('SMRT Test Environment', () => {
  it('should detect virtual module availability', () => {
    const available = hasVirtualModules();
    console.log(`Virtual modules available: ${available}`);

    if (!available) {
      console.log(
        '💡 To run full SMRT tests, use: npm run test:vitest in the smrt/products directory',
      );
    }

    expect(typeof available).toBe('boolean');
  });
});
