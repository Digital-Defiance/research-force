import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import type { Session } from '../session';
import { NAV_GROUPS, type NavGroup } from './nav-config';

/** Strip query-less trailing slashes so `/projects/` and `/projects` compare equal; the root stays `/`. */
function normalise(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Whether a link to `to` matches the location: an exact match, or `to` is a path-segment ancestor of
 * `pathname` (`/projects/9/log` matches `/projects`, but `/projects-old` and `/me/work` vs `/me` follow
 * segment boundaries). Total: any strings give a boolean, and no match is simply `false`.
 */
export function isActive(pathname: string, to: string): boolean {
  const here = normalise(pathname);
  const target = normalise(to);
  if (here === target) return true;
  if (target === '/') return false;
  return here.startsWith(`${target}/`);
}

/** The groups the viewer may see: links filtered by `session.can`, empty groups omitted. */
export function visibleGroups(session: Session): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    links: group.links.filter((link) => link.permission === undefined || session.can(link.permission)),
  })).filter((group) => group.links.length > 0);
}

/** The single most specific (longest) matching destination among the shown links, or null. */
function activeTarget(pathname: string, groups: readonly NavGroup[]): string | null {
  let best: string | null = null;
  for (const group of groups) {
    for (const link of group.links) {
      if (isActive(pathname, link.to) && (best === null || link.to.length > best.length)) best = link.to;
    }
  }
  return best;
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Grouped, role-filtered Primary_Navigation with active state and a narrow-viewport collapse toggle. */
export function PrimaryNav({ session }: { session: Session }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const groups = visibleGroups(session);
  const active = activeTarget(pathname, groups);
  return (
    <>
      <button
        type="button"
        className="rf-nav-toggle"
        aria-expanded={open}
        aria-controls="rf-primary-nav"
        onClick={() => setOpen((value) => !value)}
      >
        Menu
      </button>
      <nav id="rf-primary-nav" className={open ? 'rf-primary-nav rf-primary-nav--open' : 'rf-primary-nav'} aria-label="Workspace">
        {groups.map((group) => (
          <section key={group.label} className="rf-nav-group" aria-labelledby={`nav-${slug(group.label)}`}>
            <h2 className="rf-nav-group__label" id={`nav-${slug(group.label)}`}>{group.label}</h2>
            <ul className="rf-nav__list">
              {group.links.map((link) => (
                <li key={link.to} className="rf-nav__item">
                  <Link className="rf-nav__link" to={link.to} aria-current={link.to === active ? 'page' : undefined}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </nav>
    </>
  );
}
