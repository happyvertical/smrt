// Code methods run in QuickJS (WebAssembly): no filesystem, network, timers or
// Node APIs. A method is a pure function over a copy of the data. It returns
// { result, writes } and the engine decides whether to apply the writes.
//
// Everything crossing the boundary is JSON text: the input goes in as one
// string parsed inside the VM, the output comes out as one string parsed
// here. No host object, function or handle is ever visible to method code.
import {
  getQuickJS,
  type QuickJSWASMModule,
  shouldInterruptAfterDeadline,
} from 'quickjs-emscripten';
import { coerceValue, type FieldDef } from './definition.ts';
import { EngineError } from './errors.ts';

export interface MethodInput {
  record: Record<string, unknown> | null;
  params: Record<string, unknown>;
  data: Record<string, Record<string, unknown>[]>;
}
export interface Write {
  op: 'create' | 'update' | 'delete';
  model: string;
  id?: string;
  data?: Record<string, unknown>;
}
export interface MethodOutput {
  result: unknown;
  writes: Write[];
}

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  maxWrites: number;
  /** Largest JSON the method may return, result and writes together. */
  maxOutputBytes: number;
  /** Largest JSON of data a method may be handed. */
  maxInputBytes: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 500,
  memoryBytes: 64 * 1024 * 1024,
  // Small on purpose: past what the host's own stack can hold, V8 throws
  // out of WebAssembly and QuickJS cannot recover (see AGENTS.md).
  stackBytes: 128 * 1024,
  maxWrites: 1000,
  maxOutputBytes: 1024 * 1024,
  maxInputBytes: 8 * 1024 * 1024,
};

/** A method failed or broke a limit. */
export class SandboxError extends EngineError {
  constructor(message: string) {
    super(message, 'refused');
    this.name = 'SandboxError';
  }
}

let qjs: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => {
  qjs ??= getQuickJS();
  return qjs;
};
/**
 * The host (not the method) threw while the VM was running, e.g. V8 ran out of
 * stack inside WebAssembly. That module instance is no longer trustworthy:
 * drop it so the next method gets a fresh one.
 */
const poison = () => {
  qjs = undefined;
};

/** Disposing after a host-level failure can abort; that is the same poison. */
function disposeAll(vm: { dispose(): void }, runtime: { dispose(): void }) {
  try {
    vm.dispose();
    runtime.dispose();
  } catch {
    poison();
  }
}

const describeThrown = (e: unknown): string =>
  typeof e === 'object' && e
    ? `${(e as { name?: string }).name ?? 'Error'}: ${(e as { message?: string }).message ?? ''}`
    : String(e);

/** The body is compiled as a function body on its own, so it cannot close the wrapper. */
const COMPILE = `new Function('record', 'params', 'data', 'app', "'use strict';\\n" + globalThis.__code)`;

/**
 * Does `code` parse as a function body, and nothing more? V8 parses the body
 * on its own (it never runs), so a body such as `}); evil(); (function(){`
 * cannot close the wrapper: QuickJS's own Function constructor would accept it.
 */
function parsesAsBody(code: string): string | null {
  try {
    // Constructed, never called: parse only.
    new Function('record', 'params', 'data', 'app', `'use strict';\n${code}`);
    return null;
  } catch (e) {
    return describeThrown(e);
  }
}

/** Compile-check only: does the method body parse? Returns the problem, or null. */
export async function checkSyntax(code: string): Promise<string | null> {
  const structural = parsesAsBody(code);
  if (structural) return structural;
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(SANDBOX_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + SANDBOX_LIMITS.timeoutMs),
  );
  const vm = runtime.newContext();
  try {
    const src = vm.newString(code);
    vm.setProp(vm.global, '__code', src);
    src.dispose();
    const r = vm.evalCode(COMPILE);
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      return describeThrown(e);
    }
    r.value.dispose();
    return null;
  } finally {
    disposeAll(vm, runtime);
  }
}

export async function runMethod(
  code: string,
  input: MethodInput,
  limits: Partial<SandboxLimits> = {},
): Promise<MethodOutput> {
  const lim = { ...SANDBOX_LIMITS, ...limits };
  const structural = parsesAsBody(code);
  if (structural)
    throw new SandboxError(`method does not parse: ${structural}`);
  const json = JSON.stringify(input);
  if (json.length > lim.maxInputBytes)
    throw new SandboxError('there is too much data for a method to read');
  const deadline = Date.now() + lim.timeoutMs;
  const runtime = (await quickjs()).newRuntime();
  runtime.setMemoryLimit(lim.memoryBytes);
  runtime.setMaxStackSize(lim.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();
  try {
    for (const [k, v] of [
      ['__input', json],
      ['__code', code],
    ]) {
      const h = vm.newString(v);
      vm.setProp(vm.global, k, h);
      h.dispose();
    }
    const src = `'use strict'; (function () {
      const parse = JSON.parse;
      const stringify = JSON.stringify;
      const raw = globalThis.__input;
      const body = globalThis.__code;
      delete globalThis.__input;
      delete globalThis.__code;
      const input = parse(raw);
      const writes = [];
      // Iterative, so a hostile structure cannot overflow the stack here.
      const tooDeep = (root) => {
        const todo = [[root, 0]];
        let seen = 0;
        while (todo.length) {
          const [v, d] = todo.pop();
          if (v === null || typeof v !== 'object') continue;
          if (d > 64 || ++seen > 200000) return true;
          for (const k of Object.keys(v)) todo.push([v[k], d + 1]);
        }
        return false;
      };
      const push = (w) => {
        if (writes.length >= ${lim.maxWrites}) throw new Error('a method may propose at most ${lim.maxWrites} writes');
        if (tooDeep(w)) throw new Error('a write is nested too deeply');
        writes.push(parse(stringify(w)));
      };
      const app = Object.freeze({
        create: (model, data) => { push({ op: 'create', model, data }); },
        update: (model, id, data) => { push({ op: 'update', model, id, data }); },
        delete: (model, id) => { push({ op: 'delete', model, id }); },
      });
      const run = new Function('record', 'params', 'data', 'app', "'use strict';\\n" + body);
      const result = run(input.record, input.params, input.data, app);
      if (result && typeof result.then === 'function')
        throw new Error('a method must return a value, not a promise');
      if (tooDeep(result)) throw new Error('the result is nested too deeply');
      const out = stringify({ result: result === undefined ? null : result, writes });
      if (typeof out !== 'string' || out.length > ${lim.maxOutputBytes})
        throw new Error('the method returned too much');
      return out;
    })()`;
    const r = vm.evalCode(src, 'method.js');
    if (r.error) {
      const e = vm.dump(r.error);
      r.error.dispose();
      const timedOut = Date.now() >= deadline;
      throw new SandboxError(
        timedOut
          ? `method ran too long (limit ${lim.timeoutMs} ms)`
          : `method failed: ${describeThrown(e)}`,
      );
    }
    const text = vm.getString(r.value);
    r.value.dispose();
    let out: unknown;
    try {
      out = JSON.parse(text);
    } catch {
      throw new SandboxError('method returned something that is not JSON');
    }
    const o = out as MethodOutput;
    if (!o || typeof o !== 'object' || !Array.isArray(o.writes))
      throw new SandboxError('method returned an unexpected shape');
    return { result: o.result ?? null, writes: o.writes };
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    poison();
    throw new SandboxError(
      `method crashed the sandbox: ${(e as Error).message}`,
    );
  } finally {
    disposeAll(vm, runtime);
  }
}

export interface WritableModel {
  /** Fields a write may set: visible fields, built-in ones included. */
  fields: Record<string, FieldDef>;
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Check the writes a method proposed before anything is applied: bounded in
 * number, known operations, known models, known fields, values of the right
 * type. Returns clean copies; throws on the first problem.
 */
export function validateWrites(
  writes: unknown,
  models: Record<string, WritableModel>,
  maxWrites = SANDBOX_LIMITS.maxWrites,
): Write[] {
  if (!Array.isArray(writes)) throw new SandboxError('writes must be a list');
  if (writes.length > maxWrites)
    throw new SandboxError(`too many writes (limit ${maxWrites})`);
  const out: Write[] = [];
  writes.forEach((w, i) => {
    const at = `write ${i + 1}`;
    if (!isPlain(w)) throw new SandboxError(`${at}: not an object`);
    for (const k of Object.keys(w))
      if (!['op', 'model', 'id', 'data'].includes(k))
        throw new SandboxError(`${at}: unknown key '${k}'`);
    if (w.op !== 'create' && w.op !== 'update' && w.op !== 'delete')
      throw new SandboxError(`${at}: unknown operation '${String(w.op)}'`);
    if (typeof w.model !== 'string' || !Object.hasOwn(models, w.model))
      throw new SandboxError(`${at}: no model '${String(w.model)}'`);
    const clean: Write = { op: w.op, model: w.model };
    if (w.op !== 'create') {
      if (typeof w.id !== 'string' || !w.id)
        throw new SandboxError(`${at}: ${w.op} needs a record id`);
      clean.id = w.id;
    }
    if (w.op === 'delete') {
      if (w.data !== undefined)
        throw new SandboxError(`${at}: delete takes no data`);
    } else {
      if (!isPlain(w.data)) throw new SandboxError(`${at}: ${w.op} needs data`);
      const fields = models[w.model].fields;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(w.data)) {
        if (!Object.hasOwn(fields, k))
          throw new SandboxError(`${at}: ${w.model} has no field '${k}'`);
        const c = coerceValue(fields[k], v);
        if (!c.ok) throw new SandboxError(`${at}: ${w.model}.${k} ${c.error}`);
        data[k] = v;
      }
      clean.data = data;
    }
    out.push(clean);
  });
  return out;
}
