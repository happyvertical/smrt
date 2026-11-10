/**
 * `@happyvertical/smrt-desktop/launcher`: the assistant-plugin launcher
 * (Node only, needs `@happyvertical/smrt-app-runtime`). Separate from the
 * package root, which must never import it.
 */

export {
  LAUNCHER_FAILURES,
  type LauncherFailureCode,
  type RunLauncherOptions,
  runLauncher,
} from './launcher.js';
