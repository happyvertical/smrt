import { describe, expect, it } from 'vitest';
import {
  clampPage,
  clampPinchScale,
  commitPinchZoom,
  isImageType,
  isPdfType,
  MAX_CANVAS_PIXELS,
  MAX_ZOOM,
  MIN_ZOOM,
  renderScale,
  stepZoom,
  ZOOM_STEPS,
} from '../document-viewer-logic.js';

describe('stepZoom', () => {
  it('walks the steps both ways and stops at the ends', () => {
    expect(ZOOM_STEPS).toEqual([1, 1.5, 2, 3, 4, 5]);
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1.5, 1)).toBe(2);
    expect(stepZoom(5, 1)).toBe(5);
    expect(stepZoom(2, -1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(1);
  });
  it('moves from an in-between pinch zoom to the next step in that direction', () => {
    expect(stepZoom(2.4, 1)).toBe(3);
    expect(stepZoom(2.4, -1)).toBe(2);
  });
});

describe('pinch and page bounds', () => {
  it('bounds the live pinch scale so zoom stays in range', () => {
    expect(clampPinchScale(2, 10)).toBe(MAX_ZOOM / 2);
    expect(clampPinchScale(2, 0.1)).toBe(MIN_ZOOM / 2);
    expect(clampPinchScale(2, 1.2)).toBe(1.2);
  });
  it('commits a pinch to 0.1 within range', () => {
    expect(commitPinchZoom(2, 1.26)).toBe(2.5);
    expect(commitPinchZoom(1, 0.5)).toBe(1);
    expect(commitPinchZoom(4, 3)).toBe(5);
  });
  it('keeps pages within 1..pages', () => {
    expect(clampPage(1, -1, 5)).toBe(1);
    expect(clampPage(5, 1, 5)).toBe(5);
    expect(clampPage(2, 1, 5)).toBe(3);
    expect(clampPage(1, 1, 0)).toBe(1);
  });
});

describe('renderScale', () => {
  it('scales to the css width at the device ratio', () => {
    expect(renderScale(600, 800, 1200, 2)).toBe(4);
  });
  it('caps the canvas at MAX_CANVAS_PIXELS', () => {
    const scale = renderScale(600, 800, 6000, 2);
    expect(600 * scale * 800 * scale).toBeCloseTo(MAX_CANVAS_PIXELS, 0);
    expect(scale).toBeLessThan(20);
  });
  it('honours a custom cap', () => {
    const scale = renderScale(100, 100, 1000, 1, 10000);
    expect(100 * scale * 100 * scale).toBeCloseTo(10000, 0);
  });
});

describe('type guards', () => {
  it('recognises pdf and image types', () => {
    expect(isPdfType('application/pdf')).toBe(true);
    expect(isPdfType('Application/PDF; charset=binary')).toBe(true);
    expect(isPdfType('image/png')).toBe(false);
    expect(isImageType('image/png')).toBe(true);
    expect(isImageType('text/html')).toBe(false);
  });
});
