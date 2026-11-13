import { installTestHome } from './test-home.js';

/** Runs in the coordinator before any workers or application children exist. */
export default function setup(): () => void {
  return installTestHome();
}
