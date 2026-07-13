/**
 * Provider-neutral consumer surface.
 *
 * This mirrors what an ordinary downstream chat/persona application makes
 * reachable in its server bundle: the package roots, exactly as imported by
 * app code and by the `.smrt/register.js` file the smrtConsumer plugin
 * generates for model registration.
 *
 * Nothing here selects or configures a messaging provider, so no messaging
 * provider SDK (googleapis, nodemailer, @slack/web-api, ...) may become
 * reachable from these imports. See consumer-boundary.spec.ts.
 */
import '@happyvertical/smrt-chat';
import '@happyvertical/smrt-messages';
import '@happyvertical/smrt-personas';
