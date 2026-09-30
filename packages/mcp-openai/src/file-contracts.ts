import { json, keys, record, text } from './validation.js';

export interface OpenAiFileInput {
  file: { name: string; resourceUri: string };
}
export type FileContent =
  | { text: string; blob?: never }
  | { blob: string; text?: never };
export type FileWriteResult =
  | { outcome: 'saved' | 'conflict'; etag: string }
  | { outcome: 'too-large'; maxBytes: number };
export interface FileRead {
  uri: string;
  mimeType: string;
  content: FileContent;
  writable: boolean;
  etag?: string;
}
/** The URI is retained verbatim and is never decoded into a filesystem path. */
export function validateFileInput(value: unknown): OpenAiFileInput {
  json(value);
  const root = record(value);
  keys(root, ['file']);
  const file = record(root.file);
  keys(file, ['name', 'resourceUri']);
  const name = text(file.name, 255);
  if (
    /[\\/]/.test(name) ||
    [...name].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    ) ||
    name === '.' ||
    name === '..'
  )
    throw new TypeError('Expected filename without path');
  const uri = text(file.resourceUri, 2048);
  // Conservative local policy: opaque host/provider URI, never a URL or file path.
  if (
    !/^[a-z][a-z0-9+.-]*:/i.test(uri) ||
    /^(file|https?|data|javascript):/i.test(uri) ||
    /[\s\\]/.test(uri)
  )
    throw new TypeError('Expected opaque resource URI');
  return { file: { name, resourceUri: uri } };
}
export function fileExtensions(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    new Set(
      value.map((extension) =>
        typeof extension === 'string' ? extension.toLowerCase() : extension,
      ),
    ).size !== value.length
  )
    throw new TypeError('Expected bounded unique file extensions');
  return value.map((extension) => {
    if (!/^\.[a-z0-9][a-z0-9._-]{0,31}$/i.test(extension))
      throw new TypeError('Expected file extension');
    return extension.toLowerCase();
  });
}
export function fileContent(value: unknown, maxBytes: number): FileContent {
  json(value);
  const content = record(value);
  keys(content, ['text', 'blob']);
  let bytes: number;
  if (typeof content.text === 'string' && !Object.hasOwn(content, 'blob')) {
    bytes = new TextEncoder().encode(content.text).length;
  } else if (
    typeof content.blob === 'string' &&
    !Object.hasOwn(content, 'text')
  ) {
    const blob = content.blob;
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        blob,
      )
    )
      throw new TypeError('Expected base64 content');
    bytes =
      (blob.length / 4) * 3 -
      (blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0);
  } else throw new TypeError('Expected exactly one representation');
  if (bytes > maxBytes) throw new TypeError('File exceeds byte limit');
  return structuredClone(content) as FileContent;
}
export function fileRead(
  value: unknown,
  uri: string,
  maxBytes: number,
  mimeTypes: readonly string[],
): FileRead {
  const root = record(value);
  if (!Array.isArray(root.contents) || root.contents.length !== 1)
    throw new TypeError('Expected one granted resource');
  const item = record(root.contents[0]);
  if (item.uri !== uri) throw new TypeError('Resource URI mismatch');
  const mimeType = text(item.mimeType, 128);
  if (!mimeTypes.includes(mimeType)) throw new TypeError('File MIME denied');
  const content = fileContent(
    {
      ...(Object.hasOwn(item, 'text') ? { text: item.text } : {}),
      ...(Object.hasOwn(item, 'blob') ? { blob: item.blob } : {}),
    },
    maxBytes,
  );
  const metadata =
    item._meta === undefined
      ? {}
      : record(record(item._meta)['openai/resource'] ?? {});
  if (metadata.writable !== undefined && typeof metadata.writable !== 'boolean')
    throw new TypeError('Invalid writable metadata');
  const etag =
    metadata.etag === undefined ? undefined : text(metadata.etag, 1024);
  return {
    uri,
    mimeType,
    content,
    writable: metadata.writable === true,
    ...(etag ? { etag } : {}),
  };
}
export function fileWriteResult(value: unknown): FileWriteResult {
  json(value);
  const result = record(value);
  if (result.outcome === 'saved' || result.outcome === 'conflict')
    return { outcome: result.outcome, etag: text(result.etag, 1024) };
  if (
    result.outcome === 'too-large' &&
    Number.isSafeInteger(result.maxBytes) &&
    Number(result.maxBytes) >= 0
  )
    return { outcome: 'too-large', maxBytes: Number(result.maxBytes) };
  throw new TypeError('Invalid file write result');
}
