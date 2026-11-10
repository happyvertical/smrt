// The assistant's server half. See ../../../../README.md ("The assistant").
import { mountAssistantRoutes } from './routes.ts';

export { assistantStatus, SUBSCRIPTION_PROVIDERS } from './config.ts';
export { holdForUser } from './hold.ts';
export { mountAssistantRoutes } from './routes.ts';
export { ASSISTANT_DENIED_TOOLS, assistantTools, runTurn } from './turn.ts';

/** The shell's own handlers (API-key client from config). */
export const assistantRoutes = mountAssistantRoutes();
