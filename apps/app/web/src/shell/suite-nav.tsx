import { createElement, type ReactElement } from 'react';
import {
  createMenuType,
  MenuTypes,
  type IMenuConfig,
  type IMenuOption,
} from '@digitaldefiance/express-suite-react-components';
import FolderIcon from '@mui/icons-material/Folder';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings';
import PersonIcon from '@mui/icons-material/Person';
import type { Session } from '../session';
import { NAV_GROUPS } from './nav-config';

/** An icon per nav group, keyed by the group label from `NAV_GROUPS`. */
const GROUP_ICONS: Readonly<Record<string, () => ReactElement>> = {
  General: () => createElement(FolderIcon),
  Curation: () => createElement(FactCheckIcon),
  Administration: () => createElement(AdminPanelSettingsIcon),
  You: () => createElement(PersonIcon),
};

/**
 * Maps research-force's declarative `NAV_GROUPS` onto the Design Suite's `IMenuConfig[]`, one dropdown per group, so the
 * suite `TopMenu`/`SideMenu` present the Workspace's real navigation. Links are role-filtered here with `session.can`, the
 * same gate the former `PrimaryNav` used; a group with no permitted links is dropped (R1, R2). Routes are unchanged — each
 * option links to the exact existing `routes.tsx` path.
 */
export function navMenuConfigs(session: Session): IMenuConfig[] {
  const configs: IMenuConfig[] = [];
  let priority = NAV_GROUPS.length;
  for (const group of NAV_GROUPS) {
    const menuType = createMenuType(`nav-${group.label.toLowerCase()}`);
    const options: IMenuOption[] = group.links
      .filter((link) => link.permission === undefined || session.can(link.permission))
      .map((link, index) => ({
        id: `${menuType}-${link.to}`,
        label: link.label,
        link: link.to,
        includeOnMenus: [menuType, MenuTypes.SideMenu],
        index,
        requiresAuth: true,
      }));
    if (options.length === 0) continue;
    const icon = (GROUP_ICONS[group.label] ?? GROUP_ICONS['General'])!;
    configs.push({
      menuType,
      menuIcon: icon(),
      label: group.label,
      priority: priority--,
      options,
    });
  }
  return configs;
}
