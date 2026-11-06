import { type ReactNode } from 'react';
import { CssBaseline } from '@mui/material';
import {
  AppThemeProvider,
  AuthContext,
  I18nProvider,
  MenuProvider,
  SuiteConfigProvider,
  type IMenuConfig,
} from '@digitaldefiance/express-suite-react-components';
import { getSuiteCoreI18nEngine } from '@digitaldefiance/suite-core-lib';
import { createAppTheme } from './theme';
import { SchemeController } from './scheme';
import type { Session } from '../session';

/**
 * Adapts research-force's Cloudflare session to the shape the Design Suite's menu components read, so the suite
 * `TopMenu`/`SideMenu`/`UserMenu` render over our own auth without the suite's Express login/crypto stack (R-auth).
 *
 * The suite's `AuthContextData` is large (login, backup codes, wallet, mnemonic, …), but the menu components only read
 * `userData`, `isAuthenticated`, `admin`, `mnemonic`, `clearMnemonic`, `wallet`, `clearWallet`. We supply those from the
 * session and leave the rest unset: `mnemonic`/`wallet` undefined means the suite's "clear mnemonic/wallet" items hide,
 * and the login/register items hide because the viewer is always authenticated inside the shell.
 */
function authValue(session: Session) {
  return {
    isAuthenticated: true,
    admin: session.can('settings.edit'),
    userData: { id: session.me.member.id, roles: [] as unknown[] },
    mnemonic: undefined,
    wallet: undefined,
    clearMnemonic: () => undefined,
    clearWallet: () => undefined,
  };
}

/**
 * The real Design Suite i18n engine, with the SuiteCore component and its string tables (en-US plus the suite's other
 * languages) already registered. Using it gives correct labels ("Logout", "Dashboard", "Settings", …) and a working
 * language selector, instead of a hand-maintained stub.
 */
const i18nEngine = getSuiteCoreI18nEngine();

/** Menu ids the suite hardcodes that research-force does not offer (no in-app password change). */
const HIDDEN_MENU_IDS: readonly string[] = ['change-password', 'theme-toggle'];

/** Wraps the Workspace in the suite providers the menu components need, backed by the Cloudflare session. */
export function WorkspaceSuiteProviders({ session, menuConfigs, children }: {
  readonly session: Session;
  readonly menuConfigs: readonly IMenuConfig[];
  readonly children: ReactNode;
}) {
  return (
    <AppThemeProvider customTheme={createAppTheme}>
      <CssBaseline />
      <SuiteConfigProvider baseUrl="/api/v1" languages={[{ code: 'en-US', label: 'English (US)' }]} routes={{ dashboard: '/', settings: '/me/profile', login: '/', register: '/' }}>
        <I18nProvider i18nEngine={i18nEngine}>
          <AuthContext.Provider value={authValue(session) as never}>
            <MenuProvider menuConfigs={[...menuConfigs]} enableBackupCodes={false} hiddenMenuIds={HIDDEN_MENU_IDS}>
              <SchemeController />
              {children}
            </MenuProvider>
          </AuthContext.Provider>
        </I18nProvider>
      </SuiteConfigProvider>
    </AppThemeProvider>
  );
}
