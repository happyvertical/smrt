---
id: index
title: "SMRT Framework"
sidebar_label: "Introduction"
sidebar_position: 1
slug: /
---

# SMRT Framework

**SMRT** is a TypeScript framework for building vertical AI agents with built-in code generation, database persistence, and AI-powered operations.

## Core Philosophy

- **Define Once**: Use the `@smrt()` decorator to define business logic once
- **Generate Everything**: Automatically create REST APIs, AI tools (MCP), and CLI commands
- **AI-First**: Built-in intelligent operations with `do()`, `is()`, and `describe()` methods
- **Type-Safe**: Full TypeScript support with automatic type inference
- **Database Agnostic**: Works with SQLite, Postgres, and DuckDB

## Quick Start

### Installation

```bash
npm install @smrt/core @smrt/types
```

### Create Your First SMRT Object

```typescript
import { SmrtObject } from '@smrt/core';

// No decorator needed - it's optional
class Task extends SmrtObject {
  title = '';
  priority = 0;
  completed = false;
}
```

That's it! You now have:
- ✅ REST API endpoints: `POST /tasks`, `GET /tasks`, `GET /tasks/:id`, `PUT /tasks/:id`, `DELETE /tasks/:id`
- ✅ CLI commands: `task create`, `task list`, `task update`, `task delete`
- ✅ MCP tools for AI agents to create, read, update, and list tasks
- ✅ Database schema with automatic migrations
- ✅ Type-safe operations throughout

## What's Next?

- Explore the [Core Framework](/core) documentation
- Learn about [SMRT Packages](/) for domain-specific functionality
- Read the [API Reference](/api/core) for detailed technical documentation

