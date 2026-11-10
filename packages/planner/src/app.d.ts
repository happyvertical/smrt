// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
  namespace App {
    interface PageState {
      /** The cookbook whose detail a shallow history entry opened (`?cookbook=`). */
      cookbook?: string;
    }
  }
}

export {};
