// The ONE startup registration path for everything the shell's runtime must
// know before it initializes: permission definitions (the runtime seeds the
// owner role over the registered catalog, and grants newly registered
// permissions to an existing owner on every start) and preference kinds.
//
// `smrt.ts` imports this module before `createSmrtSvelteKitRuntime`, and
// `registry.test.ts` fails if a shell module registers anything outside the
// modules listed here, or if `smrt.ts` stops importing this first. A
// registration that happens later (a lazily imported route module) is
// invisible to that seeding, which is how `assistant.use` went missing.
import './inference-registry.ts';
import './agent-cli/settings.ts';
