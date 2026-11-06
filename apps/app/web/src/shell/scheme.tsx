import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useMenu,
  useTheme as useSuiteTheme,
  MenuTypes,
  type IMenuOption,
} from '@digitaldefiance/express-suite-react-components';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import BrightnessAutoIcon from '@mui/icons-material/BrightnessAuto';

/** The viewer's colour-scheme choice. `system` follows the OS preference; the others force a scheme. Persisted. */
export type ColorScheme = 'system' | 'light' | 'dark';
const ORDER: readonly ColorScheme[] = ['system', 'light', 'dark'];
const STORAGE_KEY = 'rf:color-scheme';

function readStored(): ColorScheme {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}
function systemDark(): boolean {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}
function resolve(scheme: ColorScheme): 'light' | 'dark' {
  return scheme === 'system' ? (systemDark() ? 'dark' : 'light') : scheme;
}

const LABEL: Readonly<Record<ColorScheme, string>> = {
  system: 'Colour scheme: system',
  light: 'Colour scheme: light',
  dark: 'Colour scheme: dark',
};

/**
 * Owns the colour-scheme preference (persisted to localStorage, defaulting to `system`) and is the single authority for
 * the scheme. It drives the suite's `AppThemeProvider` mode via `setColorMode`, mirrors that onto `<html data-scheme>`
 * so the `--rf-*` design tokens follow, and registers a drawer menu item that cycles system → light → dark. Because the
 * item toggles from this preference (not the suite's `userSettings`), the first click is always correct. The suite's
 * own `theme-toggle` is suppressed (see suite-auth) so there is exactly one authority — nothing fights the toggle.
 */
export function SchemeController() {
  const [scheme, setSchemeState] = useState<ColorScheme>(readStored);
  const { mode, setColorMode } = useSuiteTheme();
  const { registerMenuOption } = useMenu();

  const effective = resolve(scheme);

  // Keep MUI's mode in step with the resolved scheme, and mirror onto the design tokens.
  useEffect(() => {
    if (mode !== effective) setColorMode(effective);
    globalThis.document?.documentElement.setAttribute('data-scheme', effective);
  }, [effective, mode, setColorMode]);

  // Re-resolve live while on `system` if the OS preference changes.
  const [, force] = useState(0);
  useEffect(() => {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    if (media === undefined || scheme !== 'system') return undefined;
    const onChange = () => force((n) => n + 1);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [scheme]);

  const setScheme = useCallback((next: ColorScheme) => {
    setSchemeState(next);
    try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  }, []);

  // Register the drawer menu item. Keep a ref to the latest scheme so the action always cycles from the current value.
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;
  useEffect(() => {
    const option: IMenuOption = {
      id: 'rf-color-scheme',
      label: LABEL[scheme],
      icon: scheme === 'system' ? <BrightnessAutoIcon /> : scheme === 'dark' ? <Brightness7Icon /> : <Brightness4Icon />,
      includeOnMenus: [MenuTypes.SideMenu],
      index: 1000,
      requiresAuth: undefined,
      action: () => setScheme(ORDER[(ORDER.indexOf(schemeRef.current) + 1) % ORDER.length]!),
    };
    return registerMenuOption(option);
  }, [scheme, registerMenuOption, setScheme]);

  return null;
}
