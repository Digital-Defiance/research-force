import type { Permission } from '@researchforce/domain/permissions';

/** One Primary_Navigation link. `to` is always an existing `routes.tsx` path; `permission` gates visibility via `session.can`. */
export interface NavLink {
  readonly label: string;
  readonly to: string;
  readonly permission?: Permission;
}

/** A labelled set of related links. A group with no permitted links is omitted by the navigation. */
export interface NavGroup {
  readonly label: string;
  readonly links: readonly NavLink[];
}

/** Every destination the former flat header linked to, grouped; route paths are unchanged. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'General',
    links: [
      { label: 'Projects', to: '/projects' },
      { label: 'Project log', to: '/log' },
      { label: 'Findings', to: '/lists/findings' },
      { label: 'Runs', to: '/lists/runs' },
      { label: 'Hypotheses', to: '/lists/hypotheses' },
      { label: 'Correspondences', to: '/lists/correspondences' },
      { label: 'Archival requests', to: '/lists/archival-requests' },
      { label: 'My work', to: '/me/work' },
      { label: 'My drafts', to: '/me/drafts' },
      { label: 'Saved', to: '/me/saved' },
      { label: 'Search', to: '/search' },
      { label: 'Members', to: '/members' },
    ],
  },
  {
    label: 'Curation',
    links: [
      { label: 'Review queue', to: '/reviews', permission: 'review.complete' },
      { label: 'Moderation queue', to: '/moderation', permission: 'moderation.decide' },
      { label: 'Dual approvals', to: '/dual-approvals', permission: 'dual.approve' },
      { label: 'Unclassified', to: '/disclosure/unclassified', permission: 'disclosure.set' },
      { label: 'Public overview', to: '/disclosure/public-units', permission: 'disclosure.set' },
      { label: 'Evidence queue', to: '/evidence/queue', permission: 'consent.request' },
      { label: 'Consent requests', to: '/consent-requests', permission: 'consent.request' },
    ],
  },
  {
    label: 'Administration',
    links: [
      { label: 'Import a journal', to: '/imports/journal', permission: 'import.run' },
      { label: 'Import a manifest', to: '/imports/bulk', permission: 'import.run' },
      { label: 'Releases', to: '/releases', permission: 'export.manage' },
      { label: 'Exports', to: '/exports', permission: 'export.manage' },
      { label: 'Backups', to: '/backups', permission: 'backup.manage' },
      { label: 'Policy pages', to: '/admin/policy', permission: 'policy.edit' },
      { label: 'Settings', to: '/admin/settings', permission: 'settings.edit' },
      { label: 'Value sets', to: '/admin/value-sets', permission: 'valueSet.manage' },
    ],
  },
  {
    label: 'You',
    links: [
      { label: 'Your Profile', to: '/me/profile' },
      { label: 'Notification settings', to: '/me/preferences' },
    ],
  },
];
