/**
 * Tests for PlaceCollection.discoverNearby and resolveTrackPlaces.
 *
 * Mocks `@happyvertical/geo` so we don't hit the public Overpass/Google
 * endpoints during unit runs. The mock returns predictable POIs so we can
 * assert bucketing, dedupe, and throttling behavior independently of the
 * provider.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above the import they mock, so any symbols
// they reference need to come from `vi.hoisted` rather than module scope.
const { findPoisNearMock, getGeoAdapterMock } = vi.hoisted(() => ({
  findPoisNearMock: vi.fn(),
  getGeoAdapterMock: vi.fn(),
}));

vi.mock('@happyvertical/geo', async () => {
  const actual =
    await vi.importActual<typeof import('@happyvertical/geo')>(
      '@happyvertical/geo',
    );
  getGeoAdapterMock.mockImplementation(async () => ({
    lookup: vi.fn().mockResolvedValue([]),
    reverseGeocode: vi.fn().mockResolvedValue([]),
    findPoisNear: findPoisNearMock,
  }));
  return {
    ...actual,
    getGeoAdapter: getGeoAdapterMock,
  };
});

import { PlaceCollection } from './index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

function makePoi(id: string, name: string, lat: number, lon: number) {
  return {
    id,
    type: 'point_of_interest' as const,
    name,
    latitude: lat,
    longitude: lon,
    addressComponents: {},
    countryCode: 'CA',
    raw: { source: 'mock' },
  };
}

describe('PlaceCollection POI discovery', () => {
  beforeEach(() => {
    findPoisNearMock.mockReset();
  });

  it('persists POIs returned by findPoisNear', async () => {
    findPoisNearMock.mockResolvedValueOnce([
      makePoi('osm-node-1', 'Joe Coffee', 53.5461, -113.4938),
      makePoi('osm-node-2', 'Corner Store', 53.5462, -113.494),
    ]);

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('discover-basic') },
    });
    const results = await places.discoverNearby(53.5461, -113.4938, 100);

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('Joe Coffee');
    expect(findPoisNearMock).toHaveBeenCalledTimes(1);
    expect(findPoisNearMock).toHaveBeenCalledWith(
      53.5461,
      -113.4938,
      100,
      expect.objectContaining({}),
    );
  });

  it('is idempotent by externalId — second call returns existing rows', async () => {
    findPoisNearMock.mockResolvedValue([
      makePoi('osm-node-42', 'Anchor', 53.5, -113.5),
    ]);

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('discover-idempotent') },
    });

    const first = await places.discoverNearby(53.5, -113.5, 50);
    const second = await places.discoverNearby(53.5, -113.5, 50);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).toBe(second[0].id); // same row, not a duplicate
  });

  it('raises a clear error when the geo provider lacks findPoisNear', async () => {
    // Swap the mock for a one-shot adapter that doesn't implement the method.
    getGeoAdapterMock.mockResolvedValueOnce({
      lookup: vi.fn(),
      reverseGeocode: vi.fn(),
    });

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('discover-unsupported') },
    });
    await expect(places.discoverNearby(0, 0, 100)).rejects.toThrow(
      /does not implement findPoisNear/,
    );
  });
});

describe('PlaceCollection.resolveTrackPlaces', () => {
  beforeEach(() => {
    findPoisNearMock.mockReset();
  });

  it('buckets nearby points into a single request', async () => {
    findPoisNearMock.mockResolvedValue([
      makePoi('osm-node-a', 'A', 53.5461, -113.4938),
    ]);

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('track-bucket') },
    });

    // Three points all within a few meters — should collapse to one bucket.
    const result = await places.resolveTrackPlaces(
      [
        { lat: 53.5461, lng: -113.4938 },
        { lat: 53.546105, lng: -113.4938 },
        { lat: 53.54611, lng: -113.49381 },
      ],
      { radiusMeters: 50, bucketMeters: 50, throttleMs: 0 },
    );

    expect(result.bucketCount).toBe(1);
    expect(result.requestCount).toBe(1);
    expect(findPoisNearMock).toHaveBeenCalledTimes(1);
  });

  it('splits distant points into separate buckets and dedupes results', async () => {
    findPoisNearMock
      .mockResolvedValueOnce([
        makePoi('shared-poi', 'Shared Store', 53.546, -113.494),
      ])
      .mockResolvedValueOnce([
        makePoi('shared-poi', 'Shared Store', 53.546, -113.494), // same place
        makePoi('second-poi', 'Second Place', 53.547, -113.495),
      ]);

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('track-dedupe') },
    });

    const result = await places.resolveTrackPlaces(
      [
        { lat: 53.5461, lng: -113.4938 },
        { lat: 53.547, lng: -113.495 }, // ~110m away — separate bucket
      ],
      { radiusMeters: 100, bucketMeters: 50, throttleMs: 0 },
    );

    expect(result.bucketCount).toBe(2);
    expect(result.requestCount).toBe(2);
    // Shared POI appears in both responses but only once in the result.
    expect(result.places).toHaveLength(2);
    expect(new Set(result.places.map((p: any) => p.externalId))).toEqual(
      new Set(['shared-poi', 'second-poi']),
    );
  });

  it('honors throttleMs between provider calls', async () => {
    findPoisNearMock.mockResolvedValue([]);

    const places = await PlaceCollection.create({
      db: { type: 'sqlite', url: getTestDbUrl('track-throttle') },
    });

    const start = Date.now();
    await places.resolveTrackPlaces(
      [
        { lat: 53.5461, lng: -113.4938 },
        { lat: 53.547, lng: -113.495 },
      ],
      { radiusMeters: 50, bucketMeters: 50, throttleMs: 300 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(280); // allow a small jitter
  });
});
