// The request hook of storage metering (#5199): cloud only, after the response,
// never awaited. The tenant comes from the verified session context that the
// runtime's own handle set (this handle runs after it in `sequence`).
import type { Handle } from '@sveltejs/kit';
import { storageMeter } from './storage-metering.ts';

export const storageMeteringHandle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  // A map write; sampling (when due) starts without being awaited.
  storageMeter().noteRequest();
  return response;
};
