import { inspect } from 'node:util';

/** A syntactically valid token whose body is a recognizable canary. */
export const CANARY_BODY = 'CANARYLEAKCANARYLEAKCANARYLEAKCANARYLEAKxyz';
export const CANARY_TOKEN = `smrt_mcp_${CANARY_BODY}`;
/** A second valid token, for rotation tests. */
export const CANARY_TOKEN_2 = `smrt_mcp_${'ROTATEDROTATEDROTATEDROTATEDROTATEDROTATEx0'}`;
export const SLOT_ID = '2c70f518-b95a-445b-a75e-8126ae7c032a';
export const SLOT_ID_2 = '7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
export const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const ORIGIN = 'http://127.0.0.1:4678';
/** A fixed clock for expiry tests: 2026-11-01T12:00:00Z. */
export const NOW = Date.parse('2026-11-01T12:00:00Z');
export const FUTURE = '2026-12-01T12:00:00Z';

/** Every text rendering of a thrown value that could end up in a log. */
export function renderings(value: unknown): string[] {
  const out: string[] = [];
  const add = (render: () => string): void => {
    try {
      out.push(render());
    } catch {
      // A rendering that throws leaks nothing.
    }
  };
  add(() => String(value));
  add(() => inspect(value, { depth: 10, showHidden: true }));
  add(() => JSON.stringify(value) ?? '');
  if (value instanceof Error) {
    add(() => value.message);
    add(() => value.stack ?? '');
    add(() => JSON.stringify(Object.getOwnPropertyNames(value)));
    add(() =>
      JSON.stringify(
        Object.getOwnPropertyNames(value).map((key) =>
          String((value as unknown as Record<string, unknown>)[key]),
        ),
      ),
    );
    add(() => inspect((value as { cause?: unknown }).cause));
  }
  return out;
}

export function leaks(value: unknown, needle: string = CANARY_BODY): boolean {
  return renderings(value).some((text) => text.includes(needle));
}

/** Run `fn`; return what it threw (or `undefined`). */
export async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A valid #4726 success body for `slotId` (override fields to break it). */
export function mintBody(
  overrides: Record<string, unknown> = {},
  slotId: string = SLOT_ID,
): string {
  return JSON.stringify({
    id: slotId,
    token: CANARY_TOKEN,
    scopes: ['notes.read'],
    expiresAt: FUTURE,
    ...overrides,
  });
}
