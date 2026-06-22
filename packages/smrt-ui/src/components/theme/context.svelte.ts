import { getContext, setContext } from 'svelte';
import { generateTheme, type Theme } from '../../utils/theme/color.js';

const THEME_KEY = Symbol('SMRT_THEME');

export type ThemeMode = 'light' | 'dark' | 'system';

export class ThemeState {
  mode = $state<ThemeMode>('system');
  seed = $state<string>('#6750A4');
  systemPrefersDark = $state<boolean>(false);

  constructor(
    initialSeed: string = '#6750A4',
    initialMode: ThemeMode = 'system',
  ) {
    this.seed = initialSeed;
    this.mode = initialMode;

    if (typeof window !== 'undefined') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      this.systemPrefersDark = mq.matches;

      mq.addEventListener('change', (e) => {
        this.systemPrefersDark = e.matches;
      });
    }
  }

  get effectiveMode(): 'light' | 'dark' {
    if (this.mode === 'system') {
      return this.systemPrefersDark ? 'dark' : 'light';
    }
    return this.mode;
  }

  get theme(): Theme {
    return generateTheme(this.seed, this.effectiveMode);
  }

  setMode(mode: ThemeMode) {
    this.mode = mode;
  }

  setSeed(seed: string) {
    this.seed = seed;
  }
}

export function setThemeContext(seed?: string, mode?: ThemeMode) {
  const themeState = new ThemeState(seed, mode);
  setContext(THEME_KEY, themeState);
  return themeState;
}

export function getThemeContext() {
  return getContext<ThemeState>(THEME_KEY);
}
