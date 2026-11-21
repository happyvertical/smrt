/**
 * What a run event payload that was cut stores, and what a read returns
 * (docs/content/ai-runs.md section 8). The redacting append stamps the cut
 * envelope with the built-in rules it was redacted under; a read returns the
 * kept head and tail only for a row the writer flagged and stamped with the
 * current rules, and withholds them otherwise. Real SQLite and DuckDB (PGlite
 * in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  builtInRedactionStamp,
  setTranscriptRedactor,
} from '../ai-transcripts';
import { withAiRunTransaction } from '../system/ai-run-model';
import {
  AI_RUN_EVENT_PAYLOAD_MAX_BYTES,
  appendAiRunEvent,
  capAiRunEventPayload,
  getRunTrajectory,
  insertAiRunEventTx,
  openAiRun,
  toAiRunEvent,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const encoder = new TextEncoder();
const withheld = (originalBytes: number | null) => ({
  truncated: true,
  originalBytes,
  head: '',
  tail: '',
  withheld: ['head', 'tail'],
});

describe.each(
  aiRunTestEngines,
)('truncated run event payloads on %s', (engine) => {
  async function newRun(db: DatabaseInterface) {
    return openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
  }

  async function storedRow(db: DatabaseInterface, runId: string) {
    const rows = rowsOf(
      await db.query(
        'SELECT * FROM _smrt_ai_run_events WHERE run_id = $1 ORDER BY seq',
        runId,
      ),
    );
    return rows.at(-1) as Record<string, unknown>;
  }

  /** Store a payload through the public insert, as host code can. */
  async function insertedThroughPublicInsert(
    db: DatabaseInterface,
    runId: string,
    stored: { payload: string | null; truncated: boolean },
  ) {
    await withAiRunTransaction(db, (tx) =>
      insertAiRunEventTx(tx, runId, {
        id: crypto.randomUUID(),
        type: 'observation',
        payload: stored.payload,
        truncated: stored.truncated,
      }),
    );
  }

  async function readPayload(db: DatabaseInterface, runId: string) {
    const trajectory = await getRunTrajectory(db, runId);
    return trajectory?.entries.at(-1)?.event?.payload;
  }

  /** A real event row whose stored payload and flag are then replaced. */
  async function seeded(
    db: DatabaseInterface,
    stored: unknown,
    truncated: boolean,
  ) {
    const run = await newRun(db);
    await appendAiRunEvent(db, run.id, {
      type: 'observation',
      payload: { note: 'placeholder' },
    });
    await db.query(
      'UPDATE _smrt_ai_run_events SET payload = $1, truncated = $2 WHERE run_id = $3',
      typeof stored === 'string' ? stored : JSON.stringify(stored),
      truncated ? 1 : 0,
      run.id,
    );
    return run.id;
  }

  describe('writing', () => {
    it('reads a newly cut payload back with its head and tail as written', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      const payload = { text: 'a'.repeat(40_000), end: 'tail-marker' };
      await appendAiRunEvent(db, run.id, { type: 'observation', payload });
      const json = JSON.stringify(payload);
      const read = (await readPayload(db, run.id)) as Record<string, unknown>;
      expect(Object.keys(read).sort()).toEqual([
        'head',
        'originalBytes',
        'tail',
        'truncated',
      ]);
      expect(read.truncated).toBe(true);
      expect(read.originalBytes).toBe(encoder.encode(json).length);
      const head = read.head as string;
      const tail = read.tail as string;
      expect(head.length).toBeGreaterThan(1000);
      expect(json.startsWith(head)).toBe(true);
      expect(tail).toContain('tail-marker');
      expect(json.endsWith(tail)).toBe(true);
    });

    it('stamps only an envelope the redacting append wrote', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      await appendAiRunEvent(db, run.id, {
        type: 'observation',
        payload: { text: 'b'.repeat(40_000) },
      });
      const row = await storedRow(db, run.id);
      expect(JSON.parse(String(row.payload))).toMatchObject({
        truncated: true,
        redaction: builtInRedactionStamp(),
      });

      // The public cap redacts nothing, so it never stamps; a row stored
      // from it through the public insert is not read as written.
      const capped = capAiRunEventPayload({ text: 'c'.repeat(40_000) });
      expect(capped.truncated).toBe(true);
      expect(JSON.parse(String(capped.payload))).not.toHaveProperty(
        'redaction',
      );
      const fromCap = await newRun(db);
      await insertedThroughPublicInsert(db, fromCap.id, capped);
      expect(await readPayload(db, fromCap.id)).toEqual(
        withheld(
          encoder.encode(JSON.stringify({ text: 'c'.repeat(40_000) })).length,
        ),
      );
    });

    it('drops a stamp handed to the public insert', async () => {
      const db = await newAiRunTestDatabase(engine);
      const forged = await newRun(db);
      const envelope = JSON.stringify({
        truncated: true,
        originalBytes: 90_000,
        redaction: builtInRedactionStamp(),
        head: '{"password":"raw-forwarded',
        tail: 'raw-forwarded-tail"}',
      });
      await insertedThroughPublicInsert(db, forged.id, {
        payload: envelope,
        truncated: true,
      });
      const stored = JSON.parse(
        String((await storedRow(db, forged.id)).payload),
      );
      expect(stored).not.toHaveProperty('redaction');
      const read = await readPayload(db, forged.id);
      expect(read).toEqual(withheld(90_000));
      expect(JSON.stringify(read)).not.toContain('raw-forwarded');
    });

    it('reads each field of a public insert once, prototype getters included', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      const reads = new Map<string, number>();
      const count = (name: string) => {
        const n = (reads.get(name) ?? 0) + 1;
        reads.set(name, n);
        return n;
      };
      const envelope = JSON.stringify({
        truncated: true,
        originalBytes: 90_000,
        redaction: builtInRedactionStamp(),
        head: '{"password":"raw-class-forwarded',
        tail: 'raw-class-tail"}',
      });
      const id = crypto.randomUUID();
      class ForwardedEvent {
        get id() {
          count('id');
          return id;
        }
        get type() {
          count('type');
          return 'call' as const;
        }
        get payload() {
          count('payload');
          return envelope;
        }
        get truncated() {
          // Cut on the first read only: a second read would skip the strip.
          return count('truncated') === 1;
        }
        get reservation() {
          count('reservation');
          return 'reserved' as const;
        }
        get reservedTokens() {
          count('reservedTokens');
          return 42;
        }
        get reservedCost() {
          count('reservedCost');
          return 7;
        }
      }
      await withAiRunTransaction(db, (tx) =>
        insertAiRunEventTx(tx, run.id, new ForwardedEvent()),
      );
      for (const [name, n] of reads) expect([name, n]).toEqual([name, 1]);
      expect([...reads.keys()].sort()).toEqual([
        'id',
        'payload',
        'reservation',
        'reservedCost',
        'reservedTokens',
        'truncated',
        'type',
      ]);
      const row = await storedRow(db, run.id);
      expect(row).toMatchObject({ id, type: 'call', reservation: 'reserved' });
      expect(Number(row.truncated)).toBe(1);
      expect(Number(row.reserved_tokens)).toBe(42);
      expect(Number(row.reserved_cost)).toBe(7);
      expect(JSON.parse(String(row.payload))).not.toHaveProperty('redaction');
      const read = await readPayload(db, run.id);
      expect(read).toEqual(withheld(90_000));
      expect(JSON.stringify(read)).not.toContain('raw-class');
    });

    it('reads the payload input once, before the tenant decision', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      const tenants: Array<string | null> = [];
      setTranscriptRedactor((messages, context) => {
        tenants.push(context.tenantId ?? null);
        return messages;
      });
      try {
        for (const flip of [false, true]) {
          let reads = 0;
          const input = {
            type: 'observation' as const,
            get payload() {
              reads++;
              // A flipping input: nothing on the first read, a value later.
              return flip && reads === 1 ? undefined : { note: 'n' };
            },
          };
          await appendAiRunEvent(db, run.id, input);
          expect(reads).toBe(1);
        }
      } finally {
        setTranscriptRedactor(undefined);
      }
      expect(tenants).toEqual(['tenant-one']);
    });

    it('stores what an own toJSON returns only after redacting it', async () => {
      const db = await newAiRunTestDatabase(engine);
      for (const size of [10, 40_000]) {
        const run = await newRun(db);
        const payload = {
          note: 'x'.repeat(size),
          toJSON() {
            return {
              note: 'y'.repeat(size),
              password: 'raw-tojson-password',
              text: 'sk-abcdefghijklmnopqrstuvwxyz0123',
            };
          },
        };
        await appendAiRunEvent(db, run.id, { type: 'observation', payload });
        const stored = String((await storedRow(db, run.id)).payload);
        expect(stored).not.toContain('raw-tojson-password');
        expect(stored).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
        expect(stored).toContain('yyyy');
      }
    });

    it('stores a date as its JSON text and keeps binary, shared and cyclic values safe', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      const shared = { n: 1 };
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;
      await appendAiRunEvent(db, run.id, {
        type: 'observation',
        payload: {
          at: new Date('2026-11-21T00:00:00.000Z'),
          bytes: new Uint8Array([1, 2, 3]),
          shared,
          again: shared,
          cyclic,
        },
      });
      expect(await readPayload(db, run.id)).toEqual({
        at: '2026-11-21T00:00:00.000Z',
        bytes: '[binary]',
        shared: { n: 1 },
        again: '[Circular]',
        cyclic: { name: 'loop', self: '[Circular]' },
      });
      await expect(
        appendAiRunEvent(db, run.id, {
          type: 'observation',
          payload: { big: 1n },
        }),
      ).rejects.toThrow();
    });

    it('reads each payload property once when serializing it', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      const reads = { bytes: 0, note: 0 };
      const payload = {
        get bytes() {
          reads.bytes++;
          return reads.bytes === 1 ? new Uint8Array([7, 7, 7]) : 'second read';
        },
        get note() {
          reads.note++;
          if (reads.note > 1) throw new Error('read twice');
          return 'kept';
        },
      };
      await appendAiRunEvent(db, run.id, { type: 'observation', payload });
      expect(reads).toEqual({ bytes: 1, note: 1 });
      expect(await readPayload(db, run.id)).toEqual({
        bytes: '[binary]',
        note: 'kept',
      });
    });

    it('cuts a payload only between whole characters', async () => {
      const db = await newAiRunTestDatabase(engine);
      const lone =
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      for (const payload of [
        { text: '😀'.repeat(20_001) },
        { text: `x${'😀'.repeat(20_000)}` },
        { text: `${'😀'.repeat(20_000)}y` },
      ]) {
        for (const maxPayloadBytes of [257, 1000, 1001]) {
          const run = await newRun(db);
          await appendAiRunEvent(
            db,
            run.id,
            { type: 'observation', payload },
            { maxPayloadBytes },
          );
          const read = (await readPayload(db, run.id)) as {
            head: string;
            tail: string;
          };
          const json = JSON.stringify(payload);
          const source = encoder.encode(json);
          for (const fragment of [read.head, read.tail]) {
            expect(lone.test(fragment)).toBe(false);
          }
          const head = encoder.encode(read.head);
          const tail = encoder.encode(read.tail);
          expect(head.length).toBeGreaterThan(0);
          expect(tail.length).toBeGreaterThan(0);
          expect([...head]).toEqual([...source.slice(0, head.length)]);
          expect([...tail]).toEqual([
            ...source.slice(source.length - tail.length),
          ]);
        }
      }
    });

    it('keeps a stored envelope within its budget in UTF-8 bytes', async () => {
      const db = await newAiRunTestDatabase(engine);
      const payloads = [
        { text: 'a'.repeat(40_000) },
        { text: '€'.repeat(20_000) },
        { text: '😀'.repeat(20_001) },
        { text: `x${'😀'.repeat(20_000)}` },
      ];
      for (const maxPayloadBytes of [
        256,
        1000,
        AI_RUN_EVENT_PAYLOAD_MAX_BYTES,
      ]) {
        for (const payload of payloads) {
          const run = await newRun(db);
          await appendAiRunEvent(
            db,
            run.id,
            { type: 'observation', payload },
            { maxPayloadBytes },
          );
          const row = await storedRow(db, run.id);
          const stored = String(row.payload);
          expect(encoder.encode(stored).length).toBeLessThanOrEqual(
            maxPayloadBytes,
          );
          expect(Number(row.truncated)).toBe(1);
          expect(JSON.parse(stored)).toMatchObject({
            truncated: true,
            redaction: builtInRedactionStamp(),
          });
        }
      }
    });

    it('stores a payload of exactly the budget whole and cuts one byte more', async () => {
      const db = await newAiRunTestDatabase(engine);
      const budget = 1000;
      const exact = { t: 'a'.repeat(budget - '{"t":""}'.length) };
      expect(encoder.encode(JSON.stringify(exact)).length).toBe(budget);
      const whole = await newRun(db);
      await appendAiRunEvent(
        db,
        whole.id,
        { type: 'observation', payload: exact },
        { maxPayloadBytes: budget },
      );
      expect(Number((await storedRow(db, whole.id)).truncated)).toBe(0);
      expect(await readPayload(db, whole.id)).toEqual(exact);

      const over = await newRun(db);
      await appendAiRunEvent(
        db,
        over.id,
        { type: 'observation', payload: { t: `${exact.t}a` } },
        { maxPayloadBytes: budget },
      );
      expect(Number((await storedRow(db, over.id)).truncated)).toBe(1);
      expect(await readPayload(db, over.id)).toMatchObject({
        truncated: true,
        originalBytes: budget + 1,
      });
    });

    it('refuses a budget that is not an integer of at least 256 bytes before writing', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await newRun(db);
      for (const maxPayloadBytes of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -1,
        1.5,
        255,
      ]) {
        await expect(
          appendAiRunEvent(
            db,
            run.id,
            { type: 'observation', payload: { note: 'n' } },
            { maxPayloadBytes },
          ),
        ).rejects.toBeInstanceOf(RangeError);
        expect(() =>
          capAiRunEventPayload({ note: 'n' }, maxPayloadBytes),
        ).toThrow(RangeError);
      }
      // An explicit null is not "use the default".
      await expect(
        appendAiRunEvent(
          db,
          run.id,
          { type: 'observation', payload: { note: 'n' } },
          { maxPayloadBytes: null as unknown as number },
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect((await getRunTrajectory(db, run.id))?.entries).toEqual([]);
      await appendAiRunEvent(
        db,
        run.id,
        { type: 'observation', payload: { note: 'n' } },
        { maxPayloadBytes: 256 },
      );
      expect((await getRunTrajectory(db, run.id))?.entries).toHaveLength(1);
    });
  });

  describe('reading', () => {
    const current = () => builtInRedactionStamp();
    const envelope = (fields: Record<string, unknown> = {}) => ({
      truncated: true,
      originalBytes: 90_000,
      redaction: current(),
      head: '{"note":"start","dsn":"postgres://u:hunter2',
      tail: 'raw-tail-secret","end":true}',
      ...fields,
    });

    it('withholds head and tail of a cut row not stamped with the current rules', async () => {
      const db = await newAiRunTestDatabase(engine);
      const { redaction: _stamp, ...legacy } = envelope();
      const cases: unknown[] = [
        legacy,
        envelope({ redaction: current() - 1 }),
        envelope({ redaction: current() + 1 }),
        envelope({ redaction: String(current()) }),
        envelope({ redaction: current() + 0.5 }),
        envelope({ redaction: null }),
        envelope({ extra: 'field' }),
        envelope({ head: { password: 'raw-structured' } }),
        envelope({ truncated: 'yes' }),
      ];
      for (const stored of cases) {
        const runId = await seeded(db, stored, true);
        const read = await readPayload(db, runId);
        expect(read).toEqual(withheld(90_000));
        const text = JSON.stringify(read);
        for (const leaked of ['hunter2', 'raw-tail-secret', 'raw-structured']) {
          expect(text).not.toContain(leaked);
        }
      }
      const { head: _head, ...missing } = envelope();
      for (const stored of [
        missing,
        [envelope()],
        'cut text "password":"raw-x',
      ]) {
        const runId = await seeded(db, stored, true);
        const read = await readPayload(db, runId);
        expect(read).toMatchObject({
          head: '',
          tail: '',
          withheld: ['head', 'tail'],
        });
        expect(JSON.stringify(read)).not.toContain('hunter2');
        expect(JSON.stringify(read)).not.toContain('raw-x');
      }
    });

    it('withholds a credential cut before the delimiter its rule needs', async () => {
      const db = await newAiRunTestDatabase(engine);
      const { redaction: _stamp, ...legacy } = envelope({
        head: '{"note":"-----BEGIN PRIVATE KEY-----\\nMIIraw-pem-body',
      });
      const runId = await seeded(db, legacy, true);
      const text = JSON.stringify(await readPayload(db, runId));
      expect(text).not.toContain('raw-pem-body');
      const urlRun = await seeded(
        db,
        { ...legacy, head: '{"dsn":"postgres://u:hunter2' },
        true,
      );
      expect(JSON.stringify(await readPayload(db, urlRun))).not.toContain(
        'hunter2',
      );
    });

    it('reports only a valid original size on a withheld row', async () => {
      const db = await newAiRunTestDatabase(engine);
      for (const originalBytes of [-1, '9', 1.5, null]) {
        const runId = await seeded(db, envelope({ originalBytes }), true);
        expect(await readPayload(db, runId)).toEqual(withheld(null));
      }
    });

    it('withholds a flagged row whose payload is null', async () => {
      const db = await newAiRunTestDatabase(engine);
      const jsonNull = await seeded(db, 'null', true);
      expect(await readPayload(db, jsonNull)).toEqual(withheld(null));
      const sqlNull = await seeded(db, 'placeholder', true);
      await db.query(
        'UPDATE _smrt_ai_run_events SET payload = NULL WHERE run_id = $1',
        sqlNull,
      );
      expect(await readPayload(db, sqlNull)).toEqual(withheld(null));
      // An unflagged row without a payload still reads as none.
      const none = await seeded(db, 'placeholder', false);
      await db.query(
        'UPDATE _smrt_ai_run_events SET payload = NULL WHERE run_id = $1',
        none,
      );
      expect(await readPayload(db, none)).toBeNull();
    });

    it('verifies a cut only on an explicit flag and withholds an envelope whose flag is unclear', async () => {
      const db = await newAiRunTestDatabase(engine);
      const { redaction: _stamp, ...legacy } = envelope();
      const legacyRow = await storedRow(db, await seeded(db, legacy, true));
      // A stored whole payload that looks exactly like a current envelope.
      const lookalike = envelope({
        head: 'raw-lookalike sk-abcdefghijklmnopqrstuvwxyz0123',
        tail: 't',
      });
      const wholeRow = await storedRow(db, await seeded(db, lookalike, false));
      const without = (row: Record<string, unknown>) => {
        const { truncated: _flag, ...rest } = row;
        return rest;
      };

      // Explicitly cut: the stamp check applies.
      for (const truncated of [1, 1n, '1', true]) {
        const event = toAiRunEvent({ ...legacyRow, truncated });
        expect(event.truncated).toBe(true);
        expect(event.payload).toEqual(withheld(90_000));
      }
      // Explicitly whole: the payload is redacted as a structured value, even
      // one shaped like a current envelope.
      for (const truncated of [0, 0n, '0', false]) {
        const event = toAiRunEvent({ ...wholeRow, truncated });
        expect(event.truncated).toBe(false);
        expect(event.payload).toMatchObject({ redaction: current() });
        expect(event.payload).not.toHaveProperty('withheld');
        expect(JSON.stringify(event.payload)).not.toContain(
          'sk-abcdefghijklmnopqrstuvwxyz0123',
        );
      }
      // Missing or unrecognised: never verified. An envelope-shaped payload
      // (current stamp or none) is withheld; any other is redacted whole.
      const unclear = (row: Record<string, unknown>) => [
        without(row),
        ...[2, 2n, null, 't', 'true', -1].map((truncated) => ({
          ...row,
          truncated,
        })),
      ];
      for (const candidate of [...unclear(wholeRow), ...unclear(legacyRow)]) {
        const event = toAiRunEvent(candidate);
        expect(event.truncated).toBe(true);
        expect(event.payload).toEqual(withheld(90_000));
      }
      const plainRow = await storedRow(
        db,
        await seeded(db, { apiKey: 'raw-key', note: 'kept' }, false),
      );
      for (const candidate of unclear(plainRow)) {
        const event = toAiRunEvent(candidate);
        expect(event.truncated).toBe(false);
        expect(event.payload).toEqual({ apiKey: '[REDACTED]', note: 'kept' });
      }
    });

    it('withholds a cut envelope stored with a flag outside 0 and 1', async () => {
      const db = await newAiRunTestDatabase(engine);
      for (const stored of [
        envelope({ head: '{"dsn":"postgres://u:hunter2', tail: 'raw-t' }),
        (() => {
          const { redaction: _stamp, ...legacy } = envelope();
          return legacy;
        })(),
      ]) {
        const runId = await seeded(db, stored, true);
        await db.query(
          'UPDATE _smrt_ai_run_events SET truncated = 2 WHERE run_id = $1',
          runId,
        );
        const read = await readPayload(db, runId);
        expect(read).toEqual(withheld(90_000));
        expect(JSON.stringify(read)).not.toContain('hunter2');
        expect(JSON.stringify(read)).not.toContain('raw-t');
      }
    });

    it('converts a row holding a live object to inert data once', async () => {
      const db = await newAiRunTestDatabase(engine);
      const runId = await seeded(db, { note: 'placeholder' }, false);
      const row = await storedRow(db, runId);
      // Whole payload: a toJSON that would run when the host serializes it.
      const whole = toAiRunEvent({
        ...row,
        truncated: 0,
        payload: {
          note: 'n',
          toJSON() {
            return { apiKey: 'raw-live-tojson' };
          },
        },
      });
      expect(JSON.stringify(whole.payload)).not.toContain('raw-live-tojson');
      expect(JSON.stringify(whole)).not.toContain('raw-live-tojson');
      // Cut payload: fragment accessors read once, the snapshot returned.
      let reads = 0;
      const live = {
        truncated: true,
        originalBytes: 90_000,
        redaction: current(),
        tail: 't',
        get head() {
          reads++;
          return reads === 1 ? 'h' : 'raw-later-read';
        },
      };
      const cut = toAiRunEvent({ ...row, truncated: 1, payload: live });
      expect(reads).toBe(1);
      expect(cut.payload).toEqual({
        truncated: true,
        originalBytes: 90_000,
        head: 'h',
        tail: 't',
      });
      expect(JSON.stringify(cut)).not.toContain('raw-later-read');
    });

    it('returns a current stamped row as written, without the stamp', async () => {
      const db = await newAiRunTestDatabase(engine);
      const runId = await seeded(db, envelope({ head: 'h', tail: 't' }), true);
      expect(await readPayload(db, runId)).toEqual({
        truncated: true,
        originalBytes: 90_000,
        head: 'h',
        tail: 't',
      });
    });

    it('redacts an unflagged payload shaped like an envelope as an ordinary value', async () => {
      const db = await newAiRunTestDatabase(engine);
      const runId = await seeded(
        db,
        envelope({
          head: 'see sk-abcdefghijklmnopqrstuvwxyz0123',
          apiKey: 'raw-sibling-key',
        }),
        false,
      );
      const read = (await readPayload(db, runId)) as Record<string, unknown>;
      const text = JSON.stringify(read);
      expect(text).not.toContain('raw-sibling-key');
      expect(text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
      expect(read).toMatchObject({
        redaction: current(),
        apiKey: '[REDACTED]',
      });
      expect(read).not.toHaveProperty('withheld');
    });

    it('applies the same read rule when a host converts a stored row itself', async () => {
      const db = await newAiRunTestDatabase(engine);
      const { redaction: _stamp, ...legacy } = envelope();
      const legacyRun = await seeded(db, legacy, true);
      expect(toAiRunEvent(await storedRow(db, legacyRun)).payload).toEqual(
        withheld(90_000),
      );
      const plainRun = await seeded(
        db,
        { apiKey: 'raw-key', note: 'kept' },
        false,
      );
      expect(toAiRunEvent(await storedRow(db, plainRun)).payload).toEqual({
        apiKey: '[REDACTED]',
        note: 'kept',
      });
      const currentRun = await seeded(
        db,
        envelope({ head: 'h', tail: 't' }),
        true,
      );
      expect(toAiRunEvent(await storedRow(db, currentRun)).payload).toEqual({
        truncated: true,
        originalBytes: 90_000,
        head: 'h',
        tail: 't',
      });
    });
  });
});
