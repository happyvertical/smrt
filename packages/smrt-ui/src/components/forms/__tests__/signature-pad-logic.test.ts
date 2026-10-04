/**
 * Pure SignaturePad input logic, no DOM (smrt#3290). Ported from teamworks-os
 * `signature-pad-logic.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  isAcceptedPointerType,
  mapPointerToCanvasPoint,
} from '../signature-pad-logic.js';

describe('isAcceptedPointerType', () => {
  it('accepts only pen input when stylusOnly is true', () => {
    expect(isAcceptedPointerType('pen', true)).toBe(true);
    expect(isAcceptedPointerType('touch', true)).toBe(false);
    expect(isAcceptedPointerType('mouse', true)).toBe(false);
  });

  it('accepts pen, touch, and mouse when stylusOnly is false', () => {
    expect(isAcceptedPointerType('pen', false)).toBe(true);
    expect(isAcceptedPointerType('touch', false)).toBe(true);
    expect(isAcceptedPointerType('mouse', false)).toBe(true);
  });

  it('rejects unknown and empty pointer types in both modes', () => {
    for (const stylusOnly of [true, false]) {
      expect(isAcceptedPointerType('unknown', stylusOnly)).toBe(false);
      expect(isAcceptedPointerType('', stylusOnly)).toBe(false);
    }
  });
});

describe('mapPointerToCanvasPoint', () => {
  it('subtracts the rect offset unscaled when display and backing sizes match', () => {
    const rect = { left: 10, top: 20, width: 600, height: 240 };
    expect(mapPointerToCanvasPoint(110, 70, rect, 600, 240)).toEqual({
      x: 100,
      y: 50,
    });
  });

  it('scales up when displayed smaller than the backing resolution', () => {
    const rect = { left: 0, top: 0, width: 300, height: 120 };
    expect(mapPointerToCanvasPoint(30, 12, rect, 600, 240)).toEqual({
      x: 60,
      y: 24,
    });
  });

  it('scales down when displayed larger than the backing resolution', () => {
    const rect = { left: 0, top: 0, width: 1200, height: 480 };
    expect(mapPointerToCanvasPoint(1200, 480, rect, 600, 240)).toEqual({
      x: 600,
      y: 240,
    });
  });

  it('falls back to 1:1 for a zero-size (not laid out) rect', () => {
    const rect = { left: 5, top: 5, width: 0, height: 0 };
    expect(mapPointerToCanvasPoint(15, 25, rect, 600, 240)).toEqual({
      x: 10,
      y: 20,
    });
  });
});
