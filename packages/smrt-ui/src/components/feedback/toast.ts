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
  dismiss(id: string): void;
  clear(): void;
  subscribe(listener: (toasts: Toast[]) => void): () => void;
}

let nextToastId = 0;

export function createToaster(): Toaster {
  let toasts: Toast[] = [];
  const listeners = new Set<(toasts: Toast[]) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const publish = () => {
    for (const listener of listeners) listener([...toasts]);
  };

  function dismiss(id: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    toasts = toasts.filter((toast) => toast.id !== id);
    publish();
  }

  function show(input: string | ToastInput): string {
    const normalized = typeof input === 'string' ? { message: input } : input;
    const id = normalized.id ?? `toast-${++nextToastId}`;
    const existingTimer = timers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    timers.delete(id);
    const toast: Toast = {
      id,
      message: normalized.message,
      title: normalized.title,
      variant: normalized.variant ?? 'info',
      duration: normalized.duration ?? 5000,
      action: normalized.action,
    };
    toasts = [...toasts.filter((item) => item.id !== id), toast];
    publish();
    if (toast.duration > 0)
      timers.set(
        id,
        setTimeout(() => dismiss(id), toast.duration),
      );
    return id;
  }

  return {
    show,
    success: (message, input) =>
      show({ ...input, message, variant: 'success' }),
    error: (message, input) => show({ ...input, message, variant: 'error' }),
    dismiss,
    clear() {
      for (const timer of timers.values()) clearTimeout(timer);
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
