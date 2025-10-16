/**
 * Main browser entry point demonstrating auto-generated virtual modules
 */

import createClient from '@smrt/client';
import { manifest } from '@smrt/manifest';
import { tools } from '@smrt/mcp';

// Display discovered objects
function displayManifest() {
  const output = document.getElementById('manifest-output');
  if (!output) return;

  const objectsList = Object.entries(manifest.objects).map(([_name, obj]) => ({
    name: obj.className,
    collection: obj.collection,
    fields: Object.keys(obj.fields),
    methods: Object.keys(obj.methods),
    config: obj.decoratorConfig,
  }));

  output.innerHTML = `<div class="status success">Found ${objectsList.length} SMRT objects at build time</div><pre>${JSON.stringify(objectsList, null, 2)}</pre>`;
}

// Display MCP tools
function displayMCPTools() {
  const output = document.getElementById('mcp-output');
  if (!output) return;

  output.innerHTML = `<div class="status success">Generated ${tools.length} MCP tools for AI integration</div><pre>${JSON.stringify(tools, null, 2)}</pre>`;
}

// Display available routes info
function displayRoutes() {
  const output = document.getElementById('routes-output');
  if (!output) return;

  const routes = [];
  for (const [_name, obj] of Object.entries(manifest.objects)) {
    const config = obj.decoratorConfig.api;
    const exclude = (typeof config === 'object' && config?.exclude) || [];

    routes.push({
      collection: obj.collection,
      endpoints: [
        `GET /${obj.collection}`,
        `POST /${obj.collection}`,
        `GET /${obj.collection}/:id`,
        `PUT /${obj.collection}/:id`,
        ...(exclude.includes('delete')
          ? []
          : [`DELETE /${obj.collection}/:id`]),
      ],
    });
  }

  output.innerHTML = `<div class="status success">Auto-generated REST endpoints from SMRT objects</div><pre>${JSON.stringify(routes, null, 2)}</pre>`;
}

// Test API client
async function testAPI(collection: 'products' | 'categories') {
  const client = createClient('http://localhost:37428/api/v1');
  const output = document.getElementById('client-output');
  if (!output) return;

  try {
    output.innerHTML = `<div class="status">Testing ${collection}...</div>`;

    // Test listing with proper type safety
    let items: any;
    let created: any;

    if (collection === 'products') {
      items = await client.products.list();
      const testData = { name: 'Test Product', price: 29.99, inStock: true };
      created = await client.products.create(testData);
    } else {
      items = await client.categories.list();
      const testData = { name: 'Test Category', active: true };
      created = await client.categories.create(testData);
    }

    output.innerHTML = `<div class="status success">✅ ${collection} API test successful!</div><p><strong>List:</strong></p><pre>${JSON.stringify(items, null, 2)}</pre><p><strong>Created:</strong></p><pre>${JSON.stringify(created, null, 2)}</pre>`;
  } catch (error) {
    output.innerHTML = `<div class="status error">❌ API test failed: ${error instanceof Error ? error.message : String(error)}</div>`;
  }
}

// Global functions for buttons
(window as any).testProducts = () => testAPI('products');
(window as any).testCategories = () => testAPI('categories');

// Initialize page
document.addEventListener('DOMContentLoaded', () => {
  displayManifest();
  displayMCPTools();
  displayRoutes();
});
