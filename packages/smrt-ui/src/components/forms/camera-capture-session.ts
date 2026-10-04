/**
 * Framework-free `getUserMedia()` lifecycle for `CameraCapture.svelte`.
 *
 * Owns exactly one acquired `MediaStream`: requesting it, classifying a
 * rejection into one of the states the component renders, and releasing every
 * track it acquired. It never touches a `<video>` or `<canvas>`, so permission
 * denied, no camera, unsupported browser and stream cleanup are unit-testable
 * against a fake `MediaDevices` with no DOM at all. The component stays thin
 * DOM glue around it.
 *
 * Guards one race a naive "await getUserMedia, then store the stream" misses:
 * the user can dismiss the permission prompt late, or the component can be
 * disabled or unmounted, while `getUserMedia()` is still pending. Storing that
 * late result would leave the camera light on with nothing left to stop it.
 * `stop()` and every new `start()` bump a generation counter; `start()`
 * compares the generation it was issued under once the promise settles and
 * discards a stale result, stopping any tracks it just acquired.
 *
 * Ported from teamworks-os (`camera-capture-session.ts` and
 * `camera-capture-logic.ts`), smrt#3290.
 */

/** Camera facing mode requested from `getUserMedia()`. */
export type CameraFacingMode = 'environment' | 'user';

/** The failure states a camera request can surface. */
export type CameraCaptureErrorKind =
  | 'permission-denied'
  | 'no-camera'
  | 'unsupported'
  | 'error';

/**
 * Structural stand-in for `{ mediaDevices?: MediaDevices }`. lib.dom types
 * `Navigator.mediaDevices` as always present, but a browser without camera
 * support (or a page outside a secure context) leaves it `undefined`.
 */
export interface MaybeMediaDevicesHost {
  mediaDevices?: { getUserMedia?: unknown } | undefined;
}

/** The part of `MediaDevices` the session needs. */
export interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

/** Result of one `start()` call. `cancelled` means a `stop()` superseded it. */
export type CameraSessionResult =
  | { ok: true; stream: MediaStream }
  | {
      ok: false;
      kind: CameraCaptureErrorKind | 'cancelled';
      /** Diagnostic message from the rejection; not localized, not for display. */
      message: string;
    };

export interface CameraSessionDeps {
  /**
   * `navigator.mediaDevices`, resolved by the caller (`undefined` when the
   * browser has none) so this module never reaches for a global itself.
   */
  mediaDevices: MediaDevicesLike | undefined;
}

/**
 * Whether this runtime exposes `getUserMedia` at all. An unsupported browser is
 * never reported as "no camera": those states need different recovery copy.
 */
export function isCameraApiSupported(
  nav: MaybeMediaDevicesHost | undefined,
): boolean {
  return typeof nav?.mediaDevices?.getUserMedia === 'function';
}

function readStringField(value: unknown, field: 'name' | 'message') {
  if (typeof value !== 'object' || value === null || !(field in value)) {
    return undefined;
  }
  const read = (value as Record<string, unknown>)[field];
  return typeof read === 'string' ? read : undefined;
}

/**
 * Maps a `getUserMedia()` rejection to a rendered state by `DOMException.name`
 * (the cross-browser contract), never by message text.
 *
 * Deliberately does not gate on `instanceof Error`: a browser `DOMException`
 * does not inherit from `Error` in shipping engines, so that check would send
 * every real rejection to the generic state. Node's `DOMException` happening to
 * extend `Error` is what hides that bug in local tests.
 */
export function classifyGetUserMediaError(
  error: unknown,
): CameraCaptureErrorKind {
  switch (readStringField(error, 'name')) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    default:
      return 'error';
  }
}

const UNSUPPORTED_MESSAGE = 'getUserMedia is not available in this runtime.';
const GENERIC_ERROR_MESSAGE = 'Could not access the camera.';
const CANCELLED_MESSAGE = 'Camera request was superseded by stop().';

/** Create a session that owns at most one live camera stream. */
export function createCameraSession(deps: CameraSessionDeps) {
  let stream: MediaStream | null = null;
  let generation = 0;

  function releaseTracks(media: MediaStream): void {
    for (const track of media.getTracks()) track.stop();
  }

  /**
   * Request the camera. `facingMode` is a parameter, not a construction-time
   * dependency, so a caller re-reading a reactive prop always requests the
   * current value. A new `start()` supersedes the held stream (released now)
   * and any request still pending (released when it settles), so overlapping
   * calls can never leak a stream.
   */
  async function start(
    facingMode: CameraFacingMode,
  ): Promise<CameraSessionResult> {
    if (stream) {
      releaseTracks(stream);
      stream = null;
    }
    generation += 1;
    const requestGeneration = generation;
    const mediaDevices = deps.mediaDevices;
    if (!mediaDevices || !isCameraApiSupported({ mediaDevices })) {
      return { ok: false, kind: 'unsupported', message: UNSUPPORTED_MESSAGE };
    }
    try {
      const media = await mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });
      if (requestGeneration !== generation) {
        releaseTracks(media);
        return { ok: false, kind: 'cancelled', message: CANCELLED_MESSAGE };
      }
      stream = media;
      return { ok: true, stream: media };
    } catch (error) {
      if (requestGeneration !== generation) {
        return { ok: false, kind: 'cancelled', message: CANCELLED_MESSAGE };
      }
      return {
        ok: false,
        kind: classifyGetUserMediaError(error),
        message: readStringField(error, 'message') ?? GENERIC_ERROR_MESSAGE,
      };
    }
  }

  /**
   * Stop every track of the held stream, forget it, and invalidate any
   * `start()` still in flight. Idempotent: a second call (for example from a
   * `disabled` toggle and then unmount) never stops a track twice.
   */
  function stop(): void {
    generation += 1;
    if (stream) releaseTracks(stream);
    stream = null;
  }

  return {
    start,
    stop,
    /** The live stream, or `null` when none is held. */
    get stream(): MediaStream | null {
      return stream;
    },
  };
}

/** A camera session created by {@link createCameraSession}. */
export type CameraSession = ReturnType<typeof createCameraSession>;
