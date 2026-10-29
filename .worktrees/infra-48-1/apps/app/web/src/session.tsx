import { createContext, useContext } from 'react';
import type { Permission } from '@researchforce/domain/permissions';
import type { Me, Role } from './types';

export interface Session {
  readonly me: Me;
  readonly roles: readonly Role[];
  /** Whether the Member's Role grants the permission in any scope; the Worker still decides each request. */
  readonly can: (permission: Permission) => boolean;
  /** Load `/me` again after a change to it. */
  readonly refresh: () => void;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession is used outside the Workspace shell.');
  return session;
}

export function sessionFor(me: Me, roles: readonly Role[], refresh: () => void): Session {
  const role = roles.find((entry) => entry.id === me.member.roleId);
  return { me, roles, refresh, can: (permission) => role?.permissions[permission] !== undefined };
}
