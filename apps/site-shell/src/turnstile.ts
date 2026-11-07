/**
 * Loads the Bot_Check (Turnstile) widget API for the public form scripts (R31.3, R45.17). The form CSP allows its
 * origin and no other page does, so the API script is requested only here, on a form page, when the form's script
 * starts. Shared by `form.ts`, `respond.ts`, and `consent.ts`.
 */

/** The Turnstile widget API loaded in managed mode; declared here since it is a runtime-only global. */
export interface Turnstile {
  render(container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void; theme?: 'auto' }): string;
  reset(widgetId?: string): void;
}
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

/** The explicit-render API script, which leaves mounting to the form script. */
export const TURNSTILE_API = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let pending: Promise<Turnstile | null> | null = null;

/**
 * The Turnstile API: the page's own `window.turnstile` when present, otherwise the API script is injected once and
 * the promise resolves when it has loaded. Resolves `null` when the script cannot be loaded, so the form can say it
 * is unavailable rather than silently never sending.
 */
export function loadTurnstile(): Promise<Turnstile | null> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (pending !== null) return pending;
  pending = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_API;
    script.async = true;
    script.onload = () => {
      pending = null;
      resolve(window.turnstile ?? null);
    };
    script.onerror = () => {
      pending = null;
      script.remove();
      resolve(null);
    };
    document.head.append(script);
  });
  return pending;
}
