export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run(): void | Promise<void>;
}

export interface Toast {
  id: string;
  title?: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastAction;
}

export interface ToastInput extends Partial<Omit<Toast, 'id' | 'message'>> {
  id?: string;
  message: string;
}

export interface Toaster {
  show(input: string | ToastInput): string;
  success(
    message: string,
    input?: Omit<ToastInput, 'message' | 'variant'>,
  ): string;
  error(
    message: string,
    input?: Omit<ToastInput, 'message' | 'variant'>,
  ): string;
  /** Pause dismissal for a named interaction; legacy injected toasters may omit it. */
  pause?(id: string, reason?: string): void;
  /** Resume dismissal when all named interactions have ended. */
  resume?(id: string, reason?: string): void;
  dismiss(id: string): void;
  clear(): void;
  subscribe(listener: (toasts: Toast[]) => void): () => void;
}

let nextToastId = 0;

/** Default durations; zero keeps notifications until explicitly dismissed. */
export interface ToasterOptions {
  /** Default dismissal duration in milliseconds (5000 by default). */
  duration?: number;
  /** Success dismissal duration; zero preserves the only record of an action. */
  successDuration?: number;
}

/** Create an isolated notification queue with interaction-aware dismissal timers. */
export function createToaster(options: ToasterOptions = {}): Toaster {
  let toasts: Toast[] = [];
  const listeners = new Set<(toasts: Toast[]) => void>();
  interface Timer {
    handle?: ReturnType<typeof setTimeout>;
    remaining: number;
    started: number;
    reasons: Set<string>;
  }
  const timers = new Map<string, Timer>();
  const publish = () => {
    for (const listener of listeners) listener([...toasts]);
  };

  function dismiss(id: string) {
    const timer = timers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    timers.delete(id);
    toasts = toasts.filter((toast) => toast.id !== id);
    publish();
  }

  function show(input: string | ToastInput): string {
    const normalized = typeof input === 'string' ? { message: input } : input;
    const id = normalized.id ?? `toast-${++nextToastId}`;
    const existingTimer = timers.get(id);
    if (existingTimer?.handle) clearTimeout(existingTimer.handle);
    timers.delete(id);
    const toast: Toast = {
      id,
      message: normalized.message,
      title: normalized.title,
      variant: normalized.variant ?? 'info',
      duration:
        normalized.duration ??
        (normalized.variant === 'success'
          ? options.successDuration
          : undefined) ??
        options.duration ??
        5000,
      action: normalized.action,
    };
    toasts = [...toasts.filter((item) => item.id !== id), toast];
    publish();
    if (toast.duration > 0) {
      const timer: Timer = {
        remaining: toast.duration,
        started: Date.now(),
        reasons: existingTimer?.reasons ?? new Set(),
      };
      timers.set(id, timer);
      startTimer(id, timer);
    }
    return id;
  }

  function startTimer(id: string, timer: Timer) {
    if (timer.reasons.size) return;
    timer.started = Date.now();
    timer.handle = setTimeout(() => dismiss(id), timer.remaining);
  }

  function pause(id: string, reason = 'manual') {
    const timer = timers.get(id);
    if (!timer || timer.reasons.has(reason)) return;
    if (!timer.reasons.size) {
      if (timer.handle) clearTimeout(timer.handle);
      timer.handle = undefined;
      timer.remaining = Math.max(
        0,
        timer.remaining - (Date.now() - timer.started),
      );
    }
    timer.reasons.add(reason);
  }

  function resume(id: string, reason = 'manual') {
    const timer = timers.get(id);
    if (!timer || !timer.reasons.delete(reason)) return;
    startTimer(id, timer);
  }

  return {
    show,
    pause,
    resume,
    success: (message, input) =>
      show({ ...input, message, variant: 'success' }),
    error: (message, input) => show({ ...input, message, variant: 'error' }),
    dismiss,
    clear() {
      for (const timer of timers.values()) {
        if (timer.handle) clearTimeout(timer.handle);
      }
      timers.clear();
      toasts = [];
      publish();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener([...toasts]);
      return () => listeners.delete(listener);
    },
  };
}

export const toaster = createToaster();
