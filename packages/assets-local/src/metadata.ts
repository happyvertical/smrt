import sharp from 'sharp';

export interface NormalizedAssetImageMetadata {
  [key: string]: unknown;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  capturedAt: string | null;
  gps: {
    latitude: number;
    longitude: number;
  } | null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (
      typeof record.numerator === 'number' &&
      typeof record.denominator === 'number' &&
      record.denominator !== 0
    ) {
      return record.numerator / record.denominator;
    }
    if (typeof record.valueOf === 'function') {
      const parsed = Number(record.valueOf());
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function coordinatePart(value: unknown): number | null {
  const numeric = numericValue(value);
  if (numeric !== null) return numeric;
  if (typeof value !== 'string') return null;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function coordinateFromDms(value: unknown, ref: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return applyCoordinateRef(value, ref);
  }
  if (typeof value === 'string') {
    const decimal = Number(value.trim());
    if (Number.isFinite(decimal)) {
      return applyCoordinateRef(decimal, ref);
    }
    const parts = value.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (parts.length > 0) {
      return applyCoordinateRef(
        parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600,
        ref,
      );
    }
  }
  if (Array.isArray(value)) {
    const parts = value
      .map(coordinatePart)
      .filter((part): part is number => part !== null);
    if (parts.length > 0) {
      return applyCoordinateRef(
        parts[0] + (parts[1] ?? 0) / 60 + (parts[2] ?? 0) / 3600,
        ref,
      );
    }
  }
  return null;
}

function applyCoordinateRef(value: number, ref: unknown): number {
  const direction = String(ref ?? '')
    .trim()
    .toUpperCase();
  if (
    direction === 'S' ||
    direction === 'W' ||
    direction === 'SOUTH' ||
    direction === 'WEST'
  ) {
    return -Math.abs(value);
  }
  return value;
}

function dateFromExif(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  const normalized = value
    .trim()
    .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function firstPresent(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ''
    ) {
      return record[key];
    }
  }
  return undefined;
}

const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  7: 1,
  9: 4,
  10: 8,
};

function readExifTagsFromBuffer(data: Buffer): Record<string, unknown> | null {
  const tiffStart = findExifTiffStart(data);
  if (tiffStart === null) return null;
  const littleEndian =
    data.toString('ascii', tiffStart, tiffStart + 2) === 'II';
  const readUInt16 = (offset: number) =>
    littleEndian ? data.readUInt16LE(offset) : data.readUInt16BE(offset);
  const readUInt32 = (offset: number) =>
    littleEndian ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
  const readInt32 = (offset: number) =>
    littleEndian ? data.readInt32LE(offset) : data.readInt32BE(offset);
  if (readUInt16(tiffStart + 2) !== 42) return null;

  const ifd0Offset = tiffStart + readUInt32(tiffStart + 4);
  const ifd0 = readIfdEntries(
    data,
    tiffStart,
    ifd0Offset,
    readUInt16,
    readUInt32,
    readInt32,
  );
  const exifOffset = numericValue(ifd0[0x8769]);
  const gpsOffset = numericValue(ifd0[0x8825]);
  const exif =
    exifOffset !== null
      ? readIfdEntries(
          data,
          tiffStart,
          tiffStart + exifOffset,
          readUInt16,
          readUInt32,
          readInt32,
        )
      : {};
  const gps =
    gpsOffset !== null
      ? readIfdEntries(
          data,
          tiffStart,
          tiffStart + gpsOffset,
          readUInt16,
          readUInt32,
          readInt32,
        )
      : {};

  return {
    DateTimeOriginal: exif[0x9003],
    CreateDate: exif[0x9004],
    GPSLatitudeRef: gps[0x0001],
    GPSLatitude: gps[0x0002],
    GPSLongitudeRef: gps[0x0003],
    GPSLongitude: gps[0x0004],
  };
}

function findExifTiffStart(data: Buffer): number | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    offset += 2;
    if (marker === 0xda || marker === 0xd9) return null;
    const segmentLength = data.readUInt16BE(offset);
    const segmentStart = offset + 2;
    if (
      marker === 0xe1 &&
      data.toString('ascii', segmentStart, segmentStart + 6) === 'Exif\0\0'
    ) {
      return segmentStart + 6;
    }
    offset += segmentLength;
  }
  return null;
}

function readIfdEntries(
  data: Buffer,
  tiffStart: number,
  ifdOffset: number,
  readUInt16: (offset: number) => number,
  readUInt32: (offset: number) => number,
  readInt32: (offset: number) => number,
): Record<number, unknown> {
  if (ifdOffset < 0 || ifdOffset + 2 > data.length) return {};
  const count = readUInt16(ifdOffset);
  const entries: Record<number, unknown> = {};
  for (let index = 0; index < count; index++) {
    const entryOffset = ifdOffset + 2 + index * 12;
    if (entryOffset + 12 > data.length) break;
    const tag = readUInt16(entryOffset);
    const type = readUInt16(entryOffset + 2);
    const valueCount = readUInt32(entryOffset + 4);
    const value = readTiffValue(
      data,
      tiffStart,
      entryOffset,
      type,
      valueCount,
      readUInt16,
      readUInt32,
      readInt32,
    );
    if (value !== undefined) entries[tag] = value;
  }
  return entries;
}

function readTiffValue(
  data: Buffer,
  tiffStart: number,
  entryOffset: number,
  type: number,
  count: number,
  readUInt16: (offset: number) => number,
  readUInt32: (offset: number) => number,
  readInt32: (offset: number) => number,
): unknown {
  const typeSize = TIFF_TYPE_SIZE[type];
  if (!typeSize) return undefined;
  const byteLength = typeSize * count;
  const valueOffset =
    byteLength <= 4 ? entryOffset + 8 : tiffStart + readUInt32(entryOffset + 8);
  if (valueOffset < 0 || valueOffset + byteLength > data.length)
    return undefined;
  const values = Array.from({ length: count }, (_, index) =>
    readTiffScalar(
      data,
      valueOffset + index * typeSize,
      type,
      readUInt16,
      readUInt32,
      readInt32,
    ),
  );
  if (type === 2) {
    return data
      .toString('ascii', valueOffset, valueOffset + byteLength)
      .replace(/\0+$/, '')
      .trim();
  }
  return count === 1 ? values[0] : values;
}

function readTiffScalar(
  data: Buffer,
  offset: number,
  type: number,
  readUInt16: (offset: number) => number,
  readUInt32: (offset: number) => number,
  readInt32: (offset: number) => number,
): unknown {
  if (type === 3) return readUInt16(offset);
  if (type === 4) return readUInt32(offset);
  if (type === 5) {
    const denominator = readUInt32(offset + 4);
    return denominator === 0 ? null : readUInt32(offset) / denominator;
  }
  if (type === 9) return readInt32(offset);
  if (type === 10) {
    const denominator = readInt32(offset + 4);
    return denominator === 0 ? null : readInt32(offset) / denominator;
  }
  return data[offset];
}

function mimeTypeFromSharpFormat(format: string | undefined): string | null {
  if (!format) return null;
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'svg') return 'image/svg+xml';
  return `image/${format}`;
}

export function normalizeAssetImageMetadata(input: {
  width?: unknown;
  height?: unknown;
  mimeType?: unknown;
  exif?: Record<string, unknown> | null;
}): NormalizedAssetImageMetadata {
  const exif = input.exif ?? {};
  const directLatitude = numericValue(
    firstPresent(exif, ['latitude', 'Latitude', 'GPSLatitudeDecimal']),
  );
  const directLongitude = numericValue(
    firstPresent(exif, ['longitude', 'Longitude', 'GPSLongitudeDecimal']),
  );
  const latitude =
    directLatitude ??
    coordinateFromDms(
      firstPresent(exif, ['GPSLatitude', 'gpsLatitude']),
      firstPresent(exif, ['GPSLatitudeRef', 'gpsLatitudeRef']),
    );
  const longitude =
    directLongitude ??
    coordinateFromDms(
      firstPresent(exif, ['GPSLongitude', 'gpsLongitude']),
      firstPresent(exif, ['GPSLongitudeRef', 'gpsLongitudeRef']),
    );
  const capturedAt = dateFromExif(
    firstPresent(exif, [
      'DateTimeOriginal',
      'CreateDate',
      'ModifyDate',
      'SubSecDateTimeOriginal',
      'dateTimeOriginal',
      'createDate',
    ]),
  );

  return {
    width: numericValue(input.width),
    height: numericValue(input.height),
    mimeType:
      typeof input.mimeType === 'string' && input.mimeType.trim()
        ? input.mimeType.trim()
        : null,
    capturedAt,
    gps:
      latitude !== null && longitude !== null
        ? {
            latitude,
            longitude,
          }
        : null,
  };
}

export async function extractAssetImageMetadataFromBuffer(
  data: Buffer,
): Promise<NormalizedAssetImageMetadata> {
  const metadata = await sharp(data).metadata();
  const exif = readExifTagsFromBuffer(data);
  return normalizeAssetImageMetadata({
    width: metadata.width,
    height: metadata.height,
    mimeType: mimeTypeFromSharpFormat(metadata.format),
    exif: {
      ...(metadata as unknown as Record<string, unknown>),
      ...(exif ?? {}),
    },
  });
}
