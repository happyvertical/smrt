/**
 * Explicit-provider consumer surface.
 *
 * A consumer that wants functional messaging providers opts in by importing
 * the provider entry points. That import — and only that import — is allowed
 * to make the provider SDKs reachable in the server bundle.
 */
import '@happyvertical/smrt-chat';
import '@happyvertical/smrt-messages/providers/all';
