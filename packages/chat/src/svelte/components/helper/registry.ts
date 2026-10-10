import {
  createHappy,
  mountPhotoCutout,
  type PhotoCutoutRig,
} from '@happyvertical/animation';
import type { Component } from 'svelte';
import type { HelperOffering } from '../../../helper-preferences.js';

export interface HelperRendererHandle {
  destroy(): void;
  setMouthOpen(value: number): void;
  setSpeaking?(speaking: boolean): void;
}

export interface HelperStyleSetupProps {
  onsaved: (offering: HelperOffering) => void;
  oncancel: () => void;
}

export interface HelperStyleMountInput {
  target: HTMLElement;
  offering: HelperOffering;
  /** Resolved by an authenticated host bridge; never persist a URL here. */
  payload: unknown;
}

export interface HelperStyleDefinition {
  id: string;
  label: string;
  Setup?: Component<HelperStyleSetupProps>;
  mount(
    input: HelperStyleMountInput,
  ): HelperRendererHandle | Promise<HelperRendererHandle>;
}

export interface HelperStyleRegistry {
  get(id: string): HelperStyleDefinition | undefined;
  list(): readonly HelperStyleDefinition[];
}

export interface HappyRuntime {
  gsap: unknown;
  morphSVG?: object;
}

export interface HappyHelperStyleOptions {
  gsap?: unknown;
  morphSVG?: object;
  /** Called only while mounting Happy, so GSAP remains a host-owned lazy chunk. */
  loadRuntime?: () => Promise<HappyRuntime>;
}

export const HAPPY_HELPER_OFFERING: HelperOffering = {
  id: 'happy',
  label: 'Happy',
  styleId: 'happy',
  source: 'ready-made',
};

export function createHelperStyleRegistry(
  styles: readonly HelperStyleDefinition[],
): HelperStyleRegistry {
  const byId = new Map<string, HelperStyleDefinition>();
  for (const style of styles) {
    if (!style.id.trim())
      throw new Error('Helper style ids must not be blank.');
    if (byId.has(style.id))
      throw new Error(`Duplicate helper style id: ${style.id}`);
    byId.set(style.id, style);
  }
  return { get: (id) => byId.get(id), list: () => [...byId.values()] };
}

/**
 * The animation package owns Happy's SVG geometry.  This adapter never starts
 * speech: host playback can signal `setSpeaking`, while voice remains host-owned.
 */
export function createHappyHelperStyle(
  options: HappyHelperStyleOptions = {},
): HelperStyleDefinition {
  return {
    id: 'happy',
    label: 'Happy',
    async mount({ target, payload }) {
      if (payload !== null && payload !== undefined)
        throw new Error('Happy does not accept an asset payload.');
      const runtime = options.loadRuntime
        ? await options.loadRuntime()
        : { gsap: options.gsap, morphSVG: options.morphSVG };
      if (!runtime.gsap)
        throw new Error('Happy requires a trusted GSAP runtime.');
      const happy = createHappy({
        target,
        gsap: runtime.gsap as never,
        morphSVG: runtime.morphSVG,
        breathe: !prefersReducedMotion(),
      });
      let speaking = false;
      return {
        destroy: () => happy.destroy(),
        // Happy's public character API does not expose a raw mouth amount.
        // Do not call `say()`: it owns browser speech and would autoplay audio.
        setMouthOpen: (amount) => happy.setSpeaking(amount > 0.05),
        setSpeaking: (next) => {
          if (speaking === next) return;
          speaking = next;
          happy.setSpeaking(next);
        },
      };
    },
  };
}

export interface PhotoCutoutPayload {
  rig: PhotoCutoutRig;
  image: Blob;
}

function isPhotoPayload(payload: unknown): payload is PhotoCutoutPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'rig' in payload &&
    'image' in payload &&
    (payload as { image: unknown }).image instanceof Blob
  );
}

export function createPhotoCutoutHelperStyle(
  options: { Setup?: Component<HelperStyleSetupProps> } = {},
): HelperStyleDefinition {
  return {
    id: 'photo-cutout',
    label: 'Canadian split-head photo',
    ...(options.Setup ? { Setup: options.Setup } : {}),
    mount({ target, payload }) {
      if (!isPhotoPayload(payload))
        throw new Error(
          'Photographic helper requires a validated rig and image.',
        );
      const handle = mountPhotoCutout(payload.rig, {
        target,
        resolveAsset: async () =>
          new File([payload.image], 'helper-cutout.png', {
            type: payload.image.type || 'image/png',
          }),
      });
      let mouthOpen = 0;
      const setMouthOpen = (value: number) => {
        mouthOpen = Math.max(0, Math.min(1, value));
        handle.setMouthOpen(mouthOpen);
      };
      return {
        destroy: () => handle.destroy(),
        setMouthOpen,
        // CharacterConversation supplies the raw playback envelope first, then
        // this boolean state. Keep that amplitude; only an explicit stop closes
        // the mouth so cleanup stays deterministic.
        setSpeaking: (speaking) => {
          if (!speaking) setMouthOpen(0);
        },
      };
    },
  };
}

function prefersReducedMotion() {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
