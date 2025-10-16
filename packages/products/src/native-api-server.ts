#!/usr/bin/env node
/**
 * Native Node.js HTTP API server for SMRT template demo
 * Uses only built-in Node.js modules - no external dependencies
 */

import { createServer } from 'node:http';
import { URL } from 'node:url';

const port = 37428; // Obscure port number

// In-memory storage for demo
const storage: Record<string, any[]> = {
  products: [],
  categories: [],
};

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Parse JSON body from request
function parseBody(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Generate random ID
function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2);
}

// Handle API routes
async function handleRequest(req: any, res: any) {
  const url = new URL(req.url, `http://localhost:${port}`);
  const method = req.method;
  const pathname = url.pathname;

  // Set CORS headers
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Handle preflight OPTIONS requests
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  console.log(`${method} ${pathname}`);

  // Route handling
  if (pathname.startsWith('/api/v1/products')) {
    await handleProductRoutes(req, res, method, pathname);
  } else if (pathname.startsWith('/api/v1/categories')) {
    await handleCategoryRoutes(req, res, method, pathname);
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// Product route handlers
async function handleProductRoutes(
  req: any,
  res: any,
  method: string,
  pathname: string,
) {
  const parts = pathname.split('/');
  const id = parts[4]; // /api/v1/products/{id}

  try {
    if (method === 'GET' && !id) {
      // GET /api/v1/products - List products
      res.writeHead(200);
      res.end(JSON.stringify(storage.products));
    } else if (method === 'GET' && id) {
      // GET /api/v1/products/:id - Get product
      const product = storage.products.find((p) => p.id === id);
      if (!product) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Product not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(product));
    } else if (method === 'POST' && !id) {
      // POST /api/v1/product - Create product
      const body = await parseBody(req);
      const product = {
        id: generateId(),
        ...body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      storage.products.push(product);
      res.writeHead(201);
      res.end(JSON.stringify(product));
    } else if (method === 'PUT' && id) {
      // PUT /api/v1/products/:id - Update product
      const index = storage.products.findIndex((p) => p.id === id);
      if (index === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Product not found' }));
        return;
      }
      const body = await parseBody(req);
      storage.products[index] = {
        ...storage.products[index],
        ...body,
        updated_at: new Date().toISOString(),
      };
      res.writeHead(200);
      res.end(JSON.stringify(storage.products[index]));
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } catch (_error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// Category route handlers
async function handleCategoryRoutes(
  req: any,
  res: any,
  method: string,
  pathname: string,
) {
  const parts = pathname.split('/');
  const id = parts[4]; // /api/v1/categories/{id}

  try {
    if (method === 'GET' && !id) {
      // GET /api/v1/categories - List categories
      res.writeHead(200);
      res.end(JSON.stringify(storage.categories));
    } else if (method === 'GET' && id) {
      // GET /api/v1/categories/:id - Get category
      const category = storage.categories.find((c) => c.id === id);
      if (!category) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Category not found' }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify(category));
    } else if (method === 'POST' && !id) {
      // POST /api/v1/category - Create category
      const body = await parseBody(req);
      const category = {
        id: generateId(),
        ...body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      storage.categories.push(category);
      res.writeHead(201);
      res.end(JSON.stringify(category));
    } else if (method === 'PUT' && id) {
      // PUT /api/v1/categories/:id - Update category
      const index = storage.categories.findIndex((c) => c.id === id);
      if (index === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Category not found' }));
        return;
      }
      const body = await parseBody(req);
      storage.categories[index] = {
        ...storage.categories[index],
        ...body,
        updated_at: new Date().toISOString(),
      };
      res.writeHead(200);
      res.end(JSON.stringify(storage.categories[index]));
    } else if (method === 'DELETE' && id) {
      // DELETE /api/v1/categories/:id - Delete category
      const index = storage.categories.findIndex((c) => c.id === id);
      if (index === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Category not found' }));
        return;
      }
      storage.categories.splice(index, 1);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
    }
  } catch (_error) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

// Create and start server
const server = createServer(handleRequest);

server.listen(port, () => {
  console.log(`🚀 Native SMRT API server running at http://localhost:${port}`);
  console.log(`📡 API endpoints available at http://localhost:${port}/api/v1`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET    /api/v1/products     - List products');
  console.log('  POST   /api/v1/products     - Create product');
  console.log('  GET    /api/v1/products/:id - Get product');
  console.log('  PUT    /api/v1/products/:id - Update product');
  console.log('  GET    /api/v1/categories    - List categories');
  console.log('  POST   /api/v1/categories    - Create category');
  console.log('  GET    /api/v1/categories/:id - Get category');
  console.log('  PUT    /api/v1/categories/:id - Update category');
  console.log('  DELETE /api/v1/categories/:id - Delete category');
  console.log('');
  console.log(`💡 Try: curl http://localhost:${port}/api/v1/products`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
});
