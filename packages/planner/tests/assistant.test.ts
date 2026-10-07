import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyChange,
  buildResponseSchema,
  describeChange,
  parseChange,
} from '../src/lib/assistant/change.ts';
import { loadModel } from '../src/lib/assistant/engine.ts';
import { DEFAULT_MODEL_ID } from '../src/lib/assistant/models.ts';
import { loadPrefs, PREFS_KEY, savePrefs } from '../src/lib/assistant/prefs.ts';
import { buildSystemPrompt } from '../src/lib/assistant/prompt.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

beforeEach(() => recipeState.clear());

describe('schema', () => {
  it('constrains add and remove to recipe ids, not packages', () => {
    const schema = buildResponseSchema(recipes) as {
      properties: Record<string, { items?: { enum: string[] } }>;
      required: string[];
    };
    const ids = recipes.map((r) => r.id);
    expect(schema.properties.add.items?.enum).toEqual(ids);
    expect(schema.properties.remove.items?.enum).toEqual(ids);
    expect(schema.required).toEqual(['reply', 'add', 'remove']);
    expect(ids).toContain('commerce.sales');
  });

  it('puts every recipe, its summary and synonyms, and the current ones in the prompt', () => {
    const prompt = buildSystemPrompt(recipes, ['commerce.sales']);
    for (const recipe of recipes) {
      expect(prompt).toContain(recipe.id);
      expect(prompt).toContain(recipe.label);
      for (const synonym of recipe.synonyms) expect(prompt).toContain(synonym);
    }
    expect(prompt).toContain('Currently on: commerce.sales.');
    expect(buildSystemPrompt(recipes, [])).toContain('Currently on: none.');
  });
});

describe('parseChange', () => {
  it('drops unknown ids, repeats and ids both added and removed', () => {
    const change = parseChange(
      JSON.stringify({
        reply: ' Sure ',
        add: ['commerce.sales', 'commerce.sales', 'nope', 7, 'products.simple'],
        remove: ['products.simple', 'commerce.vendors'],
      }),
      recipes,
    );
    expect(change).toEqual({
      reply: 'Sure',
      add: ['commerce.sales'],
      remove: ['commerce.vendors'],
    });
  });

  it('degrades to a plain reply when the output is not the expected shape', () => {
    expect(parseChange('hello there', recipes)).toEqual({
      reply: 'hello there',
      add: [],
      remove: [],
    });
    expect(parseChange('[1]', recipes).add).toEqual([]);
    expect(parseChange('{"add":"commerce.sales"}', recipes)).toEqual({
      reply: '',
      add: [],
      remove: [],
    });
  });
});

describe('applyChange', () => {
  it('goes through the recipe store, pulling in requires', () => {
    const applied = applyChange(recipeState, {
      add: ['commerce.sales'],
      remove: [],
    });
    expect(applied.added.sort()).toEqual([
      'commerce.customers',
      'commerce.sales',
    ]);
    expect(recipeState.has('commerce.customers')).toBe(true);
    expect(describeChange(applied, recipes)).toMatch(/^Added /);
  });

  it('adds the first alternative of requiresAny', () => {
    applyChange(recipeState, { add: ['inventory.stock'], remove: [] });
    expect(recipeState.has('products.simple')).toBe(true);
  });

  it('keeps a recipe another added recipe needs and says so', () => {
    recipeState.add('commerce.sales');
    const applied = applyChange(recipeState, {
      add: [],
      remove: ['commerce.customers'],
    });
    expect(applied.removed).toEqual([]);
    expect(applied.kept).toEqual(['commerce.customers']);
    expect(describeChange(applied, recipes)).toContain('Kept Customers');
    expect(recipeState.has('commerce.customers')).toBe(true);
  });

  it('removes a recipe nothing needs', () => {
    recipeState.add('commerce.vendors');
    const applied = applyChange(recipeState, {
      add: [],
      remove: ['commerce.vendors'],
    });
    expect(applied.removed).toEqual(['commerce.vendors']);
    expect(describeChange({ added: [], removed: [], kept: [] }, recipes)).toBe(
      '',
    );
  });
});

describe('transport', () => {
  function setup(reply: string | Error) {
    const message = vi.fn<ChatModel['message']>(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const transport = createBrowserAssistantTransport({
      model: () => ({ message }),
      store: recipeState,
      recipes,
    });
    return { message, transport };
  }
  const send = (
    transport: ReturnType<typeof setup>['transport'],
    content: string,
    clientRequestId = content,
  ) => transport.sendMessage({ threadId: 'planner', content, clientRequestId });

  it('sends the schema, recipe prompt and temperature 0, then applies the change', async () => {
    const { message, transport } = setup(
      JSON.stringify({
        reply: 'Here you go.',
        add: ['commerce.sales'],
        remove: [],
      }),
    );
    const result = await send(transport, 'I take orders from customers');
    const [text, options] = message.mock.calls[0];
    expect(text).toBe('I take orders from customers');
    expect(options?.temperature).toBe(0);
    expect(options?.responseSchema).toEqual(buildResponseSchema(recipes));
    expect(options?.history?.[0]).toMatchObject({ role: 'system' });
    expect(options?.history?.[0].content).toContain('commerce.sales');
    expect(recipeState.has('commerce.sales')).toBe(true);
    expect(result.inProgress).toBe(false);
    expect(result.assistantMessage?.content).toContain('Here you go.');
    expect(result.assistantMessage?.content).toContain('Added');
  });

  it('keeps earlier turns as history and the thread readable', async () => {
    const { message, transport } = setup(
      JSON.stringify({ reply: 'ok', add: [], remove: [] }),
    );
    await send(transport, 'one');
    await send(transport, 'two');
    const history = message.mock.calls[1][1]?.history ?? [];
    expect(history.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(await transport.loadMessages('planner')).toHaveLength(4);
    expect(await transport.listThreads()).toHaveLength(1);
  });

  it('does not repeat a send with the same request id', async () => {
    const { message, transport } = setup(
      JSON.stringify({ reply: 'ok', add: [], remove: [] }),
    );
    await send(transport, 'hi', 'same');
    await send(transport, 'hi', 'same');
    expect(message).toHaveBeenCalledTimes(1);
  });

  it('answers in the chat when the model fails, and changes nothing', async () => {
    const { transport } = setup(new Error('GPU lost'));
    const result = await send(transport, 'hi');
    expect(result.assistantMessage?.content).toContain('GPU lost');
    expect(recipeState.ids).toEqual([]);
  });

  it('asks for a download when no model is loaded', async () => {
    const transport = createBrowserAssistantTransport({
      model: () => null,
      store: recipeState,
      recipes,
    });
    const result = await send(transport, 'hi');
    expect(result.assistantMessage?.content).toContain('Download a model');
  });

  it('reports a stopped turn', async () => {
    let transport!: ReturnType<typeof setup>['transport'];
    const model: ChatModel = {
      message: (_text, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
          transport.abort();
        }),
    };
    transport = createBrowserAssistantTransport({
      model: () => model,
      store: recipeState,
      recipes,
    });
    const result = await send(transport, 'hi');
    expect(result.assistantMessage?.content).toBe('Stopped.');
  });
});

describe('prefs', () => {
  function memory(): Storage {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    } as unknown as Storage;
  }

  it('round-trips the model and consent, and ignores unknown models', () => {
    const storage = memory();
    savePrefs(storage, {
      modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      consented: ['Llama-3.2-1B-Instruct-q4f16_1-MLC', 'made-up'],
    });
    expect(loadPrefs(storage)).toEqual({
      modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
      consented: ['Llama-3.2-1B-Instruct-q4f16_1-MLC'],
    });
    storage.setItem(PREFS_KEY, '{bad');
    expect(loadPrefs(storage).modelId).toBe(DEFAULT_MODEL_ID);
  });

  it('survives missing or throwing storage', () => {
    expect(loadPrefs(null).consented).toEqual([]);
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(loadPrefs(throwing).modelId).toBe(DEFAULT_MODEL_ID);
    expect(() =>
      savePrefs(throwing, { modelId: DEFAULT_MODEL_ID, consented: [] }),
    ).not.toThrow();
  });
});

describe('loadModel', () => {
  const fakeWorker = () => ({ terminate: vi.fn() }) as unknown as Worker;

  it('reports progress and returns the engine', async () => {
    const worker = fakeWorker();
    const engine = {} as never;
    const seen: number[] = [];
    const loaded = await loadModel(
      'm',
      (r) => seen.push(r.progress),
      undefined,
      {
        createWorker: () => worker,
        createEngine: async (_w, _id, onProgress) => {
          onProgress({ progress: 0.5, text: 'half' });
          return engine;
        },
      },
    );
    expect(seen).toEqual([0.5]);
    expect(loaded.engine).toBe(engine);
    loaded.dispose();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('cancels by ending the worker', async () => {
    const worker = fakeWorker();
    const controller = new AbortController();
    const pending = loadModel('m', () => {}, controller.signal, {
      createWorker: () => worker,
      createEngine: () => new Promise(() => {}),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('ends the worker when loading fails', async () => {
    const worker = fakeWorker();
    await expect(
      loadModel('m', () => {}, undefined, {
        createWorker: () => worker,
        createEngine: async () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(worker.terminate).toHaveBeenCalled();
  });
});
