import { useMemo } from 'react';
import { Link } from 'react-router';
import { Box } from '@mui/material';
import { TopMenu } from '@digitaldefiance/express-suite-react-components';
import { ActivityBadges } from '../activity/activity';
import { useApiStatus } from '../api';
import { ProfileForm } from '../people/profile';
import { StatusNotices, WorkspaceRoutes } from '../routes';
import { SessionContext, sessionFor } from '../session';
import type { Me, Role } from '../types';
import { LoadState, useLoad } from '../ui';
import { WorkspaceSuiteProviders } from './suite-auth';
import { navMenuConfigs } from './suite-nav';

/**
 * The signed-in Workspace frame (R4.1, R11.1): the Design Suite `TopMenu` (brand, grouped Primary_Navigation dropdowns,
 * a side drawer, and the user menu) over research-force's own Cloudflare session, then notices and either the requested
 * page or, while the Profile is incomplete, the Profile form. The exact session gating is preserved from the previous
 * shell: `/me` + `/roles` + `sessionFor`, the `session === null` LoadState, and the profile-incomplete gate (R3.6).
 */
export function AppShell() {
  const status = useApiStatus();
  const me = useLoad<Me>('/me');
  const roles = useLoad<{ roles: Role[] }>('/roles');
  const session = useMemo(() => (me.data && roles.data ? sessionFor(me.data, roles.data.roles, me.reload) : null), [me.data, roles.data, me.reload]);
  const gated = session !== null && (session.me.missing.length > 0 || status.profileMissing !== null);
  const menuConfigs = useMemo(() => (session === null ? [] : navMenuConfigs(session)), [session]);

  if (session === null && me.data !== undefined && (me.data.missing.length > 0 || status.profileMissing !== null)) {
    // The Worker answers every route but `/me` with `profile_incomplete` until the Profile is complete, so `/roles` cannot
    // load yet; the Profile form still replaces the page (R3.6), and the Roles load again once it is saved.
    return (
      <main className="rf-main" id="main">
        <StatusNotices />
        <ProfileForm me={me.data} onSaved={() => { me.reload(); roles.reload(); }} />
      </main>
    );
  }
  if (session === null) {
    return (
      <main className="rf-main" id="main">
        <StatusNotices />
        <LoadState error={me.error ?? roles.error} />
      </main>
    );
  }

  return (
    <WorkspaceSuiteProviders session={session} menuConfigs={menuConfigs}>
      <TopMenu Logo={<Link to="/" aria-label="ResearchForce home" style={{ display: 'inline-flex', alignItems: 'center' }}><img src="/logo-horiz-tx.png" alt="ResearchForce" style={{ height: 36, width: 'auto', display: 'block' }} /></Link>} showTitle={false} actions={<ActivityBadges />} />
      <Box
        component="main"
        id="main"
        className="rf-main"
        sx={{
          // Clear the fixed AppBar (it sits at top:10 plus the toolbar height).
          pt: 'calc(10px + 64px + 24px)',
          px: { xs: 2, sm: 3 },
          pb: 6,
          mx: 'auto',
          maxWidth: '72rem',
        }}
      >
        <StatusNotices />
        <SessionContext.Provider value={session}>
          {gated ? <ProfileForm me={session.me} onSaved={me.reload} /> : <WorkspaceRoutes />}
        </SessionContext.Provider>
      </Box>
    </WorkspaceSuiteProviders>
  );
}
