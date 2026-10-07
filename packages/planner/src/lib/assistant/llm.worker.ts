import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

// Runs the model off the UI thread; the page talks to it through
// `CreateWebWorkerMLCEngine` (see engine.ts).
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (message: MessageEvent) => {
  handler.onmessage(message);
};
