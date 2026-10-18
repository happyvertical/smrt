/** Real SvelteKit event compatibility, compiled by the package typecheck. */
import type {
  PasswordCredentialHandlers,
  PasswordRequestEvent,
} from '@happyvertical/smrt-users/sveltekit';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

type Assert<T extends true> = T;
export type EventCompatibility = Assert<
  RequestEvent extends PasswordRequestEvent ? true : false
>;
export type HandlerCompatibility = Assert<
  PasswordCredentialHandlers['signIn'] extends RequestHandler ? true : false
>;
