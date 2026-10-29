import { ROLE_IDS } from '@researchforce/domain/permissions';

export const devId = (n: number): string => `01J${String(n).padStart(23, '0')}`;
/** Shared identities for local fixtures and the opt-in local signer; never installation Members. */
export const DEV_MEMBERS = [
  { id: devId(1), email: 'admin@example.test', name: 'Synthetic Administrator', role: ROLE_IDS.administrator, status: 'active' },
  { id: devId(2), email: 'researcher@example.test', name: 'Synthetic Researcher', role: ROLE_IDS.contributor, status: 'active' },
  { id: devId(3), email: 'colleague@example.test', name: 'Synthetic Colleague', role: ROLE_IDS.contributor, status: 'active' },
  { id: devId(4), email: 'pending@example.test', name: 'Synthetic Pending Member', role: ROLE_IDS.contributor, status: 'pending' },
  { id: devId(5), email: 'revoked@example.test', name: 'Synthetic Revoked Member', role: ROLE_IDS.contributor, status: 'revoked' },
] as const;
