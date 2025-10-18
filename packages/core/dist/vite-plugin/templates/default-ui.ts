/**
 * Default SMRT Development UI
 * Auto-generated dashboard for SMRT objects
 */

import type { SmrtManifest } from '@smrt/manifest';

// Create the UI
async function createUI() {
  const app = document.getElementById('app');
  if (!app) return;

  try {
    // Import the manifest
    const { manifest } = await import('@smrt/manifest');
    const { createClient } = await import('@smrt/client');

    // Create API client
    const client = createClient('/api/v1');

    // Render the UI
    app.innerHTML = renderDashboard(manifest, client);

    // Attach event listeners
    attachEventListeners(manifest, client);
  } catch (error) {
    console.error('Error loading SMRT UI:', error);
    app.innerHTML = `
      <div class="container">
        <div class="error">
          <strong>Error loading SMRT UI</strong>
          <p>${error instanceof Error ? error.message : String(error)}</p>
        </div>
      </div>
    `;
  }
}

function renderDashboard(manifest: SmrtManifest, client: any): string {
  const objects = Object.entries(manifest.objects);
  const totalObjects = objects.length;
  const totalMethods = objects.reduce(
    (sum, [, obj]) => sum + Object.keys(obj.methods).length,
    0,
  );
  const totalFields = objects.reduce(
    (sum, [, obj]) => sum + Object.keys(obj.fields).length,
    0,
  );

  return `
    <header>
      <div class="container">
        <h1>🎯 SMRT Development UI</h1>
        <div class="subtitle">Auto-generated dashboard for your SMRT objects</div>
      </div>
    </header>

    <div class="container">
      <div class="stats">
        <div class="stat-card">
          <div class="stat-value">${totalObjects}</div>
          <div class="stat-label">Objects</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalFields}</div>
          <div class="stat-label">Fields</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${totalMethods}</div>
          <div class="stat-label">Methods</div>
        </div>
      </div>

      ${
        totalObjects === 0
          ? renderEmptyState()
          : `<div class="collections">
        ${objects.map(([name, obj]) => renderCollection(name, obj, client)).join('')}
      </div>`
      }
    </div>
  `;
}

function renderEmptyState(): string {
  return `
    <div class="empty-state">
      <svg viewBox="0 0 100 100" fill="currentColor">
        <circle cx="50" cy="50" r="40" stroke="currentColor" stroke-width="2" fill="none"/>
        <text x="50" y="60" text-anchor="middle" font-size="50">?</text>
      </svg>
      <h2>No SMRT Objects Found</h2>
      <p>Create a class that extends SmrtObject and decorate it with @smrt()</p>
    </div>
  `;
}

function renderCollection(_name: string, obj: any, _client: any): string {
  const fields = Object.entries(obj.fields);
  const methods = Object.entries(obj.methods);
  const customMethods = methods.filter(
    ([methodName]) =>
      !['list', 'get', 'create', 'update', 'delete'].includes(methodName),
  );

  return `
    <div class="collection-card" data-collection="${obj.collection}">
      <div class="collection-header">
        <div class="collection-title">${obj.className}</div>
        <div class="collection-count" data-count="${obj.collection}">Loading...</div>
      </div>
      <div class="collection-body">
        ${
          fields.length > 0
            ? `
          <h3 style="margin-bottom: 15px; color: #555;">Fields</h3>
          <div class="field-list">
            ${fields
              .map(
                ([fieldName, field]) => `
              <div class="field">
                <div class="field-name">${fieldName}</div>
                <div class="field-type">${field.type}${field.required ? ' (required)' : ''}</div>
              </div>
            `,
              )
              .join('')}
          </div>
        `
            : ''
        }

        ${
          customMethods.length > 0
            ? `
          <h3 style="margin-bottom: 15px; color: #555;">Custom Actions</h3>
          <div class="actions" style="margin-bottom: 20px;">
            ${customMethods
              .map(
                ([methodName, method]) => `
              <button
                class="btn btn-secondary"
                data-action="${methodName}"
                data-collection="${obj.collection}"
                title="${method.name}"
              >
                ${methodName}
              </button>
            `,
              )
              .join('')}
          </div>
        `
            : ''
        }

        <div class="actions">
          <button class="btn btn-primary" data-action="list" data-collection="${obj.collection}">
            📋 List All
          </button>
          <button class="btn btn-primary" data-action="create" data-collection="${obj.collection}">
            ➕ Create New
          </button>
          <a href="/api/v1/${obj.collection}" target="_blank" class="btn btn-secondary">
            🔗 API Endpoint
          </a>
        </div>
      </div>
    </div>
  `;
}

function attachEventListeners(manifest: SmrtManifest, client: any) {
  // Load counts for each collection
  void Promise.all(
    Object.values(manifest.objects).map(async (obj) => {
      try {
        const response = await client[obj.collection].list();
        const count = Array.isArray(response) ? response.length : 0;
        const countEl = document.querySelector(
          `[data-count="${obj.collection}"]`,
        );
        if (countEl) {
          countEl.textContent = `${count} items`;
        }
      } catch (error) {
        console.error(`Error loading count for ${obj.collection}:`, error);
        const countEl = document.querySelector(
          `[data-count="${obj.collection}"]`,
        );
        if (countEl) {
          countEl.textContent = 'Error';
        }
      }
    }),
  );

  // Attach button click handlers
  document.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (!target.matches('[data-action]')) return;

    const action = target.getAttribute('data-action');
    const collection = target.getAttribute('data-collection');

    if (!action || !collection) return;

    try {
      switch (action) {
        case 'list':
          await handleList(collection, client);
          break;
        case 'create':
          await handleCreate(collection, manifest, client);
          break;
        default:
          await handleCustomAction(collection, action, client);
      }
    } catch (error) {
      console.error(`Error executing ${action} on ${collection}:`, error);
      alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

async function handleList(collection: string, client: any) {
  try {
    const items = await client[collection].list();
    console.log(`${collection} items:`, items);

    // Show in a simple modal or console
    const data = JSON.stringify(items, null, 2);
    const width = Math.min(800, window.innerWidth - 40);
    const height = Math.min(600, window.innerHeight - 40);

    const newWindow = window.open(
      '',
      `${collection} List`,
      `width=${width},height=${height}`,
    );
    if (newWindow) {
      newWindow.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>${collection} - List</title>
          <style>
            body {
              font-family: monospace;
              padding: 20px;
              background: #1e1e1e;
              color: #d4d4d4;
            }
            pre {
              white-space: pre-wrap;
              word-wrap: break-word;
              background: #2d2d2d;
              padding: 15px;
              border-radius: 4px;
            }
          </style>
        </head>
        <body>
          <h1>${collection}</h1>
          <pre>${data}</pre>
        </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('Error listing items:', error);
    throw error;
  }
}

async function handleCreate(
  collection: string,
  manifest: SmrtManifest,
  _client: any,
) {
  // Get fields for this collection
  const obj = Object.values(manifest.objects).find(
    (o) => o.collection === collection,
  );
  if (!obj) return;

  const fields = Object.entries(obj.fields).filter(
    ([name]) => !['id', 'created_at', 'updated_at'].includes(name),
  );

  // Create a simple form
  const formFields = fields
    .map(
      ([name, field]) => `
    <div style="margin-bottom: 15px;">
      <label style="display: block; margin-bottom: 5px; font-weight: 600;">
        ${name} ${field.required ? '*' : ''}
      </label>
      <input
        type="${getInputType(field.type)}"
        name="${name}"
        ${field.required ? 'required' : ''}
        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;"
      />
    </div>
  `,
    )
    .join('');

  const width = Math.min(500, window.innerWidth - 40);
  const height = Math.min(600, window.innerHeight - 40);

  const newWindow = window.open(
    '',
    `Create ${collection}`,
    `width=${width},height=${height}`,
  );
  if (!newWindow) return;

  newWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Create ${obj.className}</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          padding: 20px;
          background: #f5f5f5;
        }
        form {
          background: white;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        button {
          padding: 10px 20px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1em;
        }
        button:hover {
          background: #5568d3;
        }
      </style>
    </head>
    <body>
      <h1>Create ${obj.className}</h1>
      <form id="createForm">
        ${formFields}
        <button type="submit">Create</button>
      </form>
      <script>
        document.getElementById('createForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const formData = new FormData(e.target);
          const data = Object.fromEntries(formData);

          try {
            const response = await fetch('/api/v1/${collection}', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(data)
            });

            if (response.ok) {
              alert('Created successfully!');
              window.close();
              window.opener.location.reload();
            } else {
              const error = await response.json();
              alert('Error: ' + (error.message || 'Failed to create'));
            }
          } catch (error) {
            alert('Error: ' + error.message);
          }
        });
      </script>
    </body>
    </html>
  `);
}

async function handleCustomAction(
  collection: string,
  action: string,
  client: any,
) {
  // For custom actions, we need to get an item first
  const shouldContinue = confirm(
    `This will execute the '${action}' action on the first item in ${collection}. Continue?`,
  );
  if (!shouldContinue) return;

  const items = await client[collection].list();
  if (items.length === 0) {
    alert('No items found in collection');
    return;
  }

  // Execute the custom action on the first item
  const item = items[0];
  console.log(`Executing ${action} on item:`, item);

  // Custom actions would need to be called via API
  // This is a placeholder for the actual implementation
  alert(
    `Custom action '${action}' would be executed here. Check console for details.`,
  );
}

function getInputType(fieldType: string): string {
  switch (fieldType) {
    case 'integer':
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'datetime':
      return 'datetime-local';
    default:
      return 'text';
  }
}

// Initialize the UI
createUI();
