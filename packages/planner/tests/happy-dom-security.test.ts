import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { expect, it } from 'vitest';

it('does not evaluate an invalid import alias in the Node host (GHSA-834v-8h66-3h79)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'planner-dom-security-'));
  const sentinel = '__plannerHappyDomHostSentinel';
  await writeFile(join(directory, 'dep.json'), JSON.stringify({ ok: 7 }));
  const window = new Window({
    url: 'https://planner-probe.invalid/',
    settings: {
      enableJavaScriptEvaluation: true,
      suppressCodeGenerationFromStringsWarning: true,
      fetch: {
        virtualServers: [{ url: 'https://planner-probe.invalid/', directory }],
      },
    },
  });
  window.addEventListener('error', (event) => event.preventDefault());
  try {
    const control = window.document.createElement('script');
    control.type = 'module';
    control.textContent =
      "import data from './dep.json' with { type: 'json' }; globalThis.__plannerValidModule = data.ok;";
    window.document.body.appendChild(control);
    await window.happyDOM.waitUntilComplete();
    expect(Reflect.get(window, '__plannerValidModule')).toBe(7);

    // A benign host-global sentinel proves the compiler cannot turn invalid
    // ESM into an executable default initializer. No host data is accessed.
    const source =
      "import { missing as injected = globalThis.constructor.constructor(`return globalThis`)().__plannerHappyDomHostSentinel = 1337 } from './dep.json' with { type: 'json' };";
    const native = spawnSync(
      process.execPath,
      ['--check', '--input-type=module'],
      {
        input: source,
        encoding: 'utf8',
      },
    );
    expect(native.status).toBe(1);
    expect(native.stderr).toContain('SyntaxError');
    const script = window.document.createElement('script');
    script.type = 'module';
    script.textContent = source;
    window.document.body.appendChild(script);
    await window.happyDOM.waitUntilComplete();
    expect(Reflect.get(globalThis, sentinel)).toBeUndefined();
  } finally {
    await window.happyDOM.close();
    Reflect.deleteProperty(globalThis, sentinel);
    await rm(directory, { recursive: true, force: true });
  }
});
