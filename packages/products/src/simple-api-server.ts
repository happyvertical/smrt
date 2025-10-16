#!/usr/bin/env node

/**
 * Simple API server for SMRT template demo
 * Provides working REST endpoints for testing the generated client
 */

import cors from 'cors';
import express from 'express';

const app = express();
const port = 3001;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// In-memory storage for demo
const storage: Record<string, any[]> = {
  product: [],
  category: [],
};

// Middleware for logging
app.use('/api/v1', (req, _res, next) => {
  console.log(`${req.method} ${req.path}`, req.body || '');
  next();
});

// Product endpoints
app.get('/api/v1/product', (_req, res) => {
  res.json(storage.product);
});

app.get('/api/v1/product/:id', (req, res) => {
  const item = storage.product.find((p) => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Product not found' });
  res.json(item);
});

app.post('/api/v1/product', (req, res) => {
  const id = Date.now().toString();
  const product = {
    id,
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  storage.product.push(product);
  res.status(201).json(product);
});

app.put('/api/v1/product/:id', (req, res) => {
  const index = storage.product.findIndex((p) => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Product not found' });

  storage.product[index] = {
    ...storage.product[index],
    ...req.body,
    updated_at: new Date().toISOString(),
  };
  res.json(storage.product[index]);
});

// Category endpoints
app.get('/api/v1/category', (_req, res) => {
  res.json(storage.category);
});

app.get('/api/v1/category/:id', (req, res) => {
  const item = storage.category.find((c) => c.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Category not found' });
  res.json(item);
});

app.post('/api/v1/category', (req, res) => {
  const id = Date.now().toString();
  const category = {
    id,
    ...req.body,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  storage.category.push(category);
  res.status(201).json(category);
});

app.put('/api/v1/category/:id', (req, res) => {
  const index = storage.category.findIndex((c) => c.id === req.params.id);
  if (index === -1)
    return res.status(404).json({ error: 'Category not found' });

  storage.category[index] = {
    ...storage.category[index],
    ...req.body,
    updated_at: new Date().toISOString(),
  };
  res.json(storage.category[index]);
});

app.delete('/api/v1/category/:id', (req, res) => {
  const index = storage.category.findIndex((c) => c.id === req.params.id);
  if (index === -1)
    return res.status(404).json({ error: 'Category not found' });

  storage.category.splice(index, 1);
  res.status(204).send();
});

const server = app.listen(port, () => {
  console.log(`🚀 SMRT API server running at http://localhost:${port}`);
  console.log(`📡 API endpoints available at http://localhost:${port}/api/v1`);
  console.log('');
  console.log('Available endpoints:');
  console.log('  GET    /api/v1/product     - List products');
  console.log('  POST   /api/v1/product     - Create product');
  console.log('  GET    /api/v1/product/:id - Get product');
  console.log('  PUT    /api/v1/product/:id - Update product');
  console.log('  GET    /api/v1/category    - List categories');
  console.log('  POST   /api/v1/category    - Create category');
  console.log('  GET    /api/v1/category/:id - Get category');
  console.log('  PUT    /api/v1/category/:id - Update category');
  console.log('  DELETE /api/v1/category/:id - Delete category');
  console.log('');
  console.log(`💡 Try: curl http://localhost:${port}/api/v1/product`);
});

// Keep server alive
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
});
