/** Unit coverage for the shipped MCP Apps bridge component (#3373). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { McpAppsBridge } from '../index.js';

describe('McpAppsBridge', () => {
  it('renders the app heading and stays inline without an embedding host', async () => {
    // jsdom's top-level window is its own parent, which the portable bridge
    // rejects; the component must keep its ordinary inline view.
    render(McpAppsBridge, {
      props: {
        hostOrigin: 'https://host.example',
        appInfo: { name: 'unit', version: '1' },
        title: 'Items',
        description: 'Review authorized items.',
      },
    });
    expect(screen.getByRole('heading', { name: 'Items' })).toBeTruthy();
    expect(screen.getByText('Review authorized items.')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe(
        'Host controls are unavailable; this view remains inline.',
      ),
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('rejects a non-exact host origin as an inline fallback, not a mount crash', async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    render(McpAppsBridge, {
      props: {
        hostOrigin: 'https://host.example/path',
        appInfo: { name: 'unit', version: '1' },
        title: 'Items',
        hostWindow: () => frame.contentWindow as Window,
      },
    });
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.queryByRole('button')).toBeNull();
    frame.remove();
  });

  it('imports no server code, credentials or OpenAI helpers', () => {
    const dir = join(import.meta.dirname, '..');
    for (const file of [
      'McpAppsBridge.svelte',
      'mcp-apps.svelte.ts',
      'index.ts',
      'strings.ts',
    ]) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(
        /smrt-app-mcp|smrt-mcp-openai|['"]jose['"]|node:|\$env|process\.env/u,
      );
    }
  });
});
