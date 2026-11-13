/**
 * The browser-facing entries stay browser-safe (#4752, #4754): no `node:`
 * built-ins, no value import of the AI SDK and no smrt-config anywhere in
 * the relative import graph of the root entry or of `./models` (generated
 * consumer registration imports the model from there). `./node`,
 * `./server` and `./resolver` (#4756: smrt-secrets and the ambient principal)
 * are the Node-only subpaths. The graph is walked from each entry, so a new
 * module is covered as soon as an entry reaches it.
 * `hosted.ts` (#4759) is part of `./node` (secrets, runOnce, the gateway
 * admin client).
 * `./gate` (#4760) builds on `./resolver`'s principal and is Node-only too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { engineLabel } from '../index.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function graph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(
      /(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g,
    )) {
      const specifier = (match[1] ?? match[2]) as string;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (existsSync(target)) visit(target);
    }
  };
  visit(join(SRC, entry));
  return [...seen].map((file) => file.slice(SRC.length + 1)).sort();
}

describe.each(['index.ts', 'models.ts'])('%s import graph', (entry) => {
  const files = graph(entry);

  it('is walked', () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).not.toContain('node.ts');
    expect(files).not.toContain('server.ts');
    expect(files).not.toContain('resolver.ts');
    expect(files).not.toContain('hosted.ts');
    expect(files).not.toContain('gate.ts');
  });

  it.each(
    files,
  )('%s imports no node: module, AI SDK value or smrt-config', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(
      /import\s+\{[^}]*\}\s+from ['"]@happyvertical\/ai['"]/,
    );
    expect(source).not.toMatch(/from ['"]@happyvertical\/smrt-config['"]/);
  });

  it.each(files)('%s never reaches the Node-only stores', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source).not.toMatch(
      /from ['"]\.\/(node|resolver|hosted|gate)\.js['"]/,
    );
    expect(source).not.toMatch(
      /from ['"]@happyvertical\/smrt-(secrets|tenancy|users)['"]/,
    );
  });
});

it('the root graph covers the executor and config', () => {
  expect(graph('index.ts')).toEqual(
    expect.arrayContaining([
      'index.ts',
      'executor.ts',
      'config.ts',
      'provider-config.ts',
      'engine-id.ts',
      'agent-cli/tools.ts',
    ]),
  );
});

it('exports shared human engine labels from the browser-safe root', () => {
  expect(
    ['claude-code', 'codex', 'chatgpt', 'api'].map((engine) =>
      engineLabel(engine as Parameters<typeof engineLabel>[0]),
    ),
  ).toEqual(['Claude Code', 'Codex', 'ChatGPT', 'your API key']);
  expect(graph('index.ts')).not.toContain('engine-status.ts');
});

it('server engine code never imports a host or approval authority', () => {
  const files = graph('server.ts').filter((name) =>
    /^(agent-cli\/|chatgpt\/model|engine-)/.test(name),
  );
  expect(files.length).toBeGreaterThan(10);
  for (const name of files) {
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source, name).not.toMatch(
      /from ['"]@happyvertical\/smrt-(app-shell|chat|app-runtime)/,
    );
    expect(source, name).not.toMatch(/decideApproval|approved\s*:\s*true/);
  }
});
