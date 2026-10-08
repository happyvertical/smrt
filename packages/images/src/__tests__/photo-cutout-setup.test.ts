import { describe, expect, it } from 'vitest';
import {
  assembleCanadianSplitRig,
  faceOutlinePrompt,
  parseMouthLandmarks,
  parsePhotoCutoutSetup,
  photoCutoutSetupPrompt,
} from '../photo-cutout-setup.js';

const source = { assetId: 'source', width: 100, height: 120 };
const rig = {
  rigKind: 'photo-cutout',
  version: 1,
  id: 'portrait',
  ariaLabel: 'Portrait',
  canvas: { width: 100, height: 120 },
  layers: [
    {
      id: 'head',
      assetId: 'source',
      role: 'head',
      clip: [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 110 },
        { x: 10, y: 110 },
      ],
    },
    {
      id: 'mouth',
      kind: 'solid',
      role: 'mouth-interior',
      color: { r: 20, g: 10, b: 10 },
      clip: [
        { x: 35, y: 70 },
        { x: 65, y: 70 },
        { x: 50, y: 90 },
      ],
    },
    {
      id: 'jaw',
      assetId: 'source',
      role: 'jaw',
      clip: [
        { x: 25, y: 65 },
        { x: 75, y: 65 },
        { x: 75, y: 105 },
        { x: 25, y: 105 },
      ],
    },
  ],
  jaw: { layerId: 'jaw', pivot: { x: 50, y: 65 } },
};

describe('parsePhotoCutoutSetup', () => {
  it('accepts ordered mouth corners and chin landmarks', () => {
    expect(
      parseMouthLandmarks({
        mouthLeft: { x: 340, y: 520 },
        mouthRight: { x: 660, y: 520 },
        chin: { x: 500, y: 880 },
      }),
    ).toMatchObject({ chin: { y: 880 } });
  });
  it('asks for a tight hair and ear silhouette rather than a rectangle', () => {
    const prompt = faceOutlinePrompt();
    expect(prompt).toContain('labeled coordinate grid');
    expect(prompt).toContain('highest visible hair point');
    expect(prompt).toContain('Exclude background beside hair and ears');
    expect(prompt).toContain('24-48 points');
  });
  it('rejects inverted landmark anatomy', () => {
    expect(() =>
      parseMouthLandmarks({
        mouthLeft: { x: 660, y: 520 },
        mouthRight: { x: 340, y: 520 },
        chin: { x: 500, y: 400 },
      }),
    ).toThrow('anatomically invalid');
  });
  it('leaves the Canadian split opening transparent instead of adding a mouth fill', () => {
    const rig = assembleCanadianSplitRig({
      outline: {
        points: [
          { x: 200, y: 100 },
          { x: 800, y: 100 },
          { x: 940, y: 500 },
          { x: 760, y: 900 },
          { x: 240, y: 900 },
          { x: 60, y: 500 },
        ],
      },
      landmarks: {
        mouthLeft: { x: 350, y: 550 },
        mouthRight: { x: 650, y: 550 },
        chin: { x: 500, y: 850 },
      },
      assetId: 'source',
      width: 100,
      height: 120,
    });

    expect(rig.layers.map((layer) => layer.role)).toEqual(['head', 'jaw']);
    // The opening derives from the detected chin span, with equal canvas
    // padding so the photographed jaw cannot clip while it translates.
    expect(rig.jaw.maxOpenOffset?.y).toBe(13);
    expect(rig.canvas.height).toBe(133);
  });
  it.each([
    [100, 120],
    [800, 696],
  ])('ships a validator-safe few-shot rig for %ix%i', (width, height) => {
    const prompt = photoCutoutSetupPrompt({ assetId: 'source', width, height });
    const example = JSON.parse(prompt.split('\n')[1]).rig;
    expect(
      parsePhotoCutoutSetup(
        { rig: example },
        { assetId: 'source', width, height },
      ),
    ).toBeTruthy();
    expect(prompt).toContain(`${width}x${height}`);
  });
  it('accepts validator-safe geometry bound to the source asset', () => {
    const parsed = parsePhotoCutoutSetup({ rig }, source);
    const jaw = parsed.layers.find((layer) => layer.role === 'jaw');
    const mouth = parsed.layers.find(
      (layer) => layer.role === 'mouth-interior',
    );
    expect(mouth?.clip).toEqual(jaw?.clip);
  });
  it('rejects a model response that references an unapproved asset', () => {
    const unsafe = structuredClone(rig);
    unsafe.layers[0].assetId = 'remote';
    expect(() => parsePhotoCutoutSetup({ rig: unsafe }, source)).toThrow(
      'authorized source',
    );
  });
});
