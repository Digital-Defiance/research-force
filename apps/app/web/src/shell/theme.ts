import { createTheme, type PaletteMode, type Theme } from '@mui/material';

/**
 * The Workspace MUI theme (R6). Plain hex per mode (MUI derives light/dark/contrast variants, which needs parseable
 * colours and cannot use `var()`). The values mirror the `--rf-*` design tokens so MUI and the `.rf-*` styles agree in
 * each scheme; `SchemeSync` switches `mode` in lock-step with the tokens' `data-scheme`, so toggling flips both.
 */
const C = {
  light: {
    surface: '#eef1f6', raised: '#f8fafc', text: '#243041', muted: '#566173', subtle: '#d4dae6',
    accent: '#1f4fd1', onAccent: '#ffffff', danger: '#a3161a', warning: '#7a4a00', success: '#1d6b34', info: '#1f4fd1',
  },
  dark: {
    surface: '#1e2330', raised: '#273041', text: '#eceef2', muted: '#aeb6c6', subtle: '#39435a',
    accent: '#93b6ff', onAccent: '#10131a', danger: '#ff9a8f', warning: '#f0bb5a', success: '#7fd69a', info: '#93b6ff',
  },
} as const;

export function createAppTheme(mode: PaletteMode): Theme {
  const c = mode === 'light' ? C.light : C.dark;
  return createTheme({
    palette: {
      mode,
      primary: { main: c.accent, contrastText: c.onAccent },
      secondary: { main: c.info, contrastText: c.onAccent },
      error: { main: c.danger },
      warning: { main: c.warning },
      success: { main: c.success },
      info: { main: c.info },
      background: { default: c.surface, paper: c.raised },
      text: { primary: c.text, secondary: c.muted },
      divider: c.subtle,
    },
    typography: {
      fontFamily: "'Inter', 'Inter Fallback', system-ui, sans-serif",
      h1: { fontWeight: 600 }, h2: { fontWeight: 600 }, h3: { fontWeight: 600 },
      h4: { fontWeight: 600 }, h5: { fontWeight: 600 }, h6: { fontWeight: 600 },
    },
    components: {
      MuiAppBar: { styleOverrides: { root: { background: 'linear-gradient(135deg, #15357f 0%, #0e3a44 100%)' } } },
      MuiButton: { styleOverrides: { root: { textTransform: 'none', borderRadius: 6 } } },
    },
  });
}

export default createAppTheme;
