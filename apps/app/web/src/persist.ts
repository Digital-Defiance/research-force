import { useCallback, useState } from 'react';

/**
 * Unsent input is mirrored into `sessionStorage`, which belongs to one browser tab and survives its reloads, until the
 * input is sent successfully or discarded (R28.10).
 */
export const UNSENT_PREFIX = 'rf:unsent:';

function storage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function readUnsent<T>(key: string): T | undefined {
  const stored = storage()?.getItem(UNSENT_PREFIX + key);
  if (stored === null || stored === undefined) return undefined;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return undefined;
  }
}

export function writeUnsent(key: string, value: unknown): void {
  try {
    storage()?.setItem(UNSENT_PREFIX + key, JSON.stringify(value));
  } catch {
    // A full or unavailable store loses only the reload copy; the input stays in the page.
  }
}

export function clearUnsent(key: string): void {
  storage()?.removeItem(UNSENT_PREFIX + key);
}

export interface PersistentForm<T> {
  readonly values: T;
  /** Whether the values came back from this tab's storage after a reload. */
  readonly restored: boolean;
  readonly set: <K extends keyof T>(field: K, value: T[K]) => void;
  readonly replace: (values: T) => void;
  /** Forget the unsent input and return to the initial values. */
  readonly discard: () => void;
  /** Forget the unsent input after it was sent successfully, keeping what the page shows. */
  readonly sent: () => void;
}

/** A form's field values, kept in this tab's storage on every change until sent or discarded. */
export function usePersistentForm<T extends object>(key: string, initial: T | (() => T)): PersistentForm<T> {
  const [initialValues] = useState(initial);
  const [state, setState] = useState(() => {
    const stored = readUnsent<T>(key);
    return stored === undefined ? { values: initialValues, restored: false } : { values: { ...initialValues, ...stored }, restored: true };
  });
  const set = useCallback(<K extends keyof T>(field: K, value: T[K]) => {
    setState((current) => {
      const values = { ...current.values, [field]: value };
      writeUnsent(key, values);
      return { ...current, values };
    });
  }, [key]);
  const replace = useCallback((values: T) => {
    writeUnsent(key, values);
    setState((current) => ({ ...current, values }));
  }, [key]);
  const discard = useCallback(() => {
    clearUnsent(key);
    setState({ values: initialValues, restored: false });
  }, [key, initialValues]);
  const sent = useCallback(() => {
    clearUnsent(key);
    setState((current) => ({ ...current, restored: false }));
  }, [key]);
  return { values: state.values, restored: state.restored, set, replace, discard, sent };
}
